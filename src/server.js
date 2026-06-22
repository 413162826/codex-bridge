import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { evaluateApiAccess, publicSecurityConfig } from './accessControl.js';
import { AppRegistry, resolveAppEffectiveCodexConfig } from './appRegistry.js';
import { sandboxModeFromPolicy, sandboxPolicyFromMode, threadExecutionParams, turnExecutionParams } from './appServerProtocol.js';
import { CodexAppServerClient } from './codexAppServerClient.js';
import { createHiddenCodexDirectiveStreamFilter, stripHiddenCodexDirectives } from './codexDirectives.js';
import { createCodexSdkRuntime } from './codexSdkRuntime.js';
import { createCodexHistory } from './codexHistory.js';
import { toStrictJsonSchema, tryParseJson } from './complete.js';
import { createRuntimeConfig, mergeConfig } from './config.js';
import { createImageUpload, extractWorkspaceImagePaths, isPathInside, resolveUploadAppId } from './fileGateway.js';
import { readJsonBody, sendError, sendJson, sendText } from './json.js';
import { attachmentSummary, buildMobileCodexInput, materializeMobileAttachments, toAppServerInput } from './mobileAttachments.js';
import { orderMobileProjects } from './mobileProjects.js';
import { resolveMobileSessionView } from './mobileSessionResolver.js';
import { bridgeSessionMessages } from './mobileSessionView.js';
import { createNativeHistoryMonitor } from './nativeHistoryMonitor.js';
import { createOpenApiSpec } from './openapi.js';
import { PushNotificationStore, buildCompletionPayload } from './pushNotifications.js';
import { SessionStore, classifyConnectionNotice } from './sessionStore.js';
import { normalizeStaticPathname } from './staticPaths.js';
import { loadBridgeState, saveBridgeState } from './stateStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const publicRoot = path.join(projectRoot, 'public');
const swaggerUiRoot = path.join(projectRoot, 'node_modules', 'swagger-ui-dist');

const persistedState = await loadBridgeState();
const config = createRuntimeConfig();
mergeConfig(config, persistedState.config);
const apps = new AppRegistry({ apps: persistedState.apps });
const store = new SessionStore({ sessions: persistedState.sessions });
const pushNotifications = new PushNotificationStore({ state: persistedState.push });
const history = createCodexHistory();
const mobileRuntime = createCodexSdkRuntime();
const mobileWarmups = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(200);
const nativeHistoryMonitor = createNativeHistoryMonitor({
  history,
  store,
  publish,
  intervalMs: nativeHistoryMonitorIntervalMs(),
  watchEnabled: nativeHistoryMonitorWatchEnabled(),
});

let codex = createClient();
wireClient(codex);

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => sendError(res, error));
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`Codex Bridge listening on http://${config.server.host}:${config.server.port}`);
  startNativeHistoryMonitor();
  if (process.env.BRIDGE_CODEX_AUTOSTART !== '0') {
    codex
      .ensureStarted()
      .then(() => prewarmStartupMobileDefault())
      .catch((error) => {
        publish({ type: 'codex.autostart.error', error: error.message, receivedAt: new Date().toISOString() });
      });
  }
});

function createClient() {
  return new CodexAppServerClient({ cwd: config.codex.cwd });
}

function wireClient(client) {
  client.on('notification', (event) => {
    const turnId = event.params?.turnId || event.params?.turn?.id || null;
    const wasEphemeral = store.isEphemeralTurn(turnId);
    store.applyNotification(event);
    schedulePersist();
    publish({ type: 'codex.notification', ...event });
    if (!wasEphemeral && event.method === 'turn/completed') {
      publishMobileUnread(event).catch((error) => {
        publish({ type: 'bridge.mobile.unread.error', error: error.message, receivedAt: new Date().toISOString() });
      });
    }
  });

  client.on('serverRequest', (request) => {
    publish({ type: 'codex.serverRequest', request, receivedAt: new Date().toISOString() });
  });

  client.on('serverRequest/resolvedLocally', (request) => {
    publish({ type: 'codex.serverRequest.resolved', request, receivedAt: new Date().toISOString() });
  });

  client.on('stderr', (text) => {
    publish({ type: 'codex.stderr', text, receivedAt: new Date().toISOString() });
  });

  client.on('close', (payload) => {
    publish({ type: 'codex.close', ...payload, receivedAt: new Date().toISOString() });
  });
}

function publish(event) {
  bus.emit('event', event);
}

function startNativeHistoryMonitor() {
  if (process.env.CODEX_BRIDGE_NATIVE_HISTORY_MONITOR === '0') {
    publish({ type: 'bridge.native-history-monitor.disabled', receivedAt: new Date().toISOString() });
    return;
  }
  nativeHistoryMonitor.start();
  publish({ type: 'bridge.native-history-monitor.started', receivedAt: new Date().toISOString() });
}

function nativeHistoryMonitorIntervalMs() {
  const value = Number(process.env.CODEX_BRIDGE_NATIVE_HISTORY_POLL_MS || '');
  return Number.isFinite(value) && value >= 1000 ? value : undefined;
}

function nativeHistoryMonitorWatchEnabled() {
  return process.env.CODEX_BRIDGE_NATIVE_HISTORY_WATCH !== '0';
}

async function publishMobileUnread(event) {
  const params = event.params || {};
  const turn = params.turn || {};
  if (turn.status && turn.status !== 'completed') {
    return;
  }

  const threadId = params.threadId || params.thread?.id || '';
  if (!threadId) {
    return;
  }

  const bridgeSession = store.get(threadId);
  if (bridgeSession) {
    const project = await projectForCwd(bridgeSession.cwd);
    publish({
      type: 'bridge.mobile.unread',
      sessionId: bridgeSession.id,
      threadId: bridgeSession.threadId || bridgeSession.id,
      title: bridgeSession.name || project?.name || projectNameFromPath(bridgeSession.cwd) || 'Codex 回复完成',
      cwd: bridgeSession.cwd,
      projectId: project?.id || null,
      projectName: project?.name || projectNameFromPath(bridgeSession.cwd),
      updatedAt: bridgeSession.updatedAt || event.receivedAt || new Date().toISOString(),
      turnId: turn.id || params.turnId || null,
      source: 'bridge',
      receivedAt: new Date().toISOString(),
    });
    return;
  }

  const meta = await history.getThreadMeta(threadId);
  if (!meta) {
    return;
  }
  publish({
    type: 'bridge.mobile.unread',
    sessionId: threadId,
    threadId,
    title: meta.title || meta.projectName || 'Codex 回复完成',
    cwd: meta.cwd,
    projectId: meta.projectId || null,
    projectName: meta.projectName || projectNameFromPath(meta.cwd),
    updatedAt: meta.updatedAt || event.receivedAt || new Date().toISOString(),
    turnId: turn.id || params.turnId || null,
    source: 'codex-history',
    receivedAt: new Date().toISOString(),
  });
}

async function projectForCwd(cwd) {
  if (!cwd) {
    return null;
  }
  try {
    const projects = await history.listProjects();
    return pickProjectForCwd(projects, cwd);
  } catch {
    return null;
  }
}

async function handleRequest(req, res) {
  setBaseHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }

  if (url.pathname === '/docs' || url.pathname === '/swagger') {
    await serveFile(res, path.join(publicRoot, 'swagger.html'));
    return;
  }

  if (url.pathname.startsWith('/swagger-ui/')) {
    const relativePath = url.pathname.slice('/swagger-ui/'.length);
    await serveFile(res, path.join(swaggerUiRoot, relativePath));
    return;
  }

  await serveStatic(req, res, url);
}

function setBaseHeaders(res) {
  if (config.server.cors) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,authorization,x-codex-bridge-key,x-codex-app-id');
  }
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const access = evaluateApiAccess({ req, security: config.security, apps });
  req.access = access;
  if (!access.allowed) {
    sendJson(res, access.statusCode || 403, {
      error: {
        message: access.message || '无权访问该 API',
        statusCode: access.statusCode || 403,
      },
    });
    return;
  }

  if (route === 'GET /api/health') {
    sendJson(res, 200, { ok: true, bridge: publicConfig(), codex: codex.getStatus() });
    return;
  }

  if (route === 'GET /api/status') {
    sendJson(res, 200, {
      bridge: publicConfig(),
      codex: codex.getStatus(),
      sessions: visibleSessions(req).map(summarySession),
      serverRequests: codex.listServerRequests(),
      events: store.events.slice(-80),
    });
    return;
  }

  if (route === 'GET /api/config') {
    sendJson(res, 200, publicConfig());
    return;
  }

  if (route === 'GET /api/openapi.json') {
    sendJson(res, 200, createOpenApiSpec(config));
    return;
  }

  if (route === 'PUT /api/config') {
    const patch = await readJsonBody(req);
    mergeConfig(config, patch);
    await persistState();
    publish({ type: 'bridge.config.updated', config: publicConfig(), receivedAt: new Date().toISOString() });
    sendJson(res, 200, publicConfig());
    return;
  }

  if (route === 'POST /api/codex/start') {
    await codex.ensureStarted();
    sendJson(res, 200, { ok: true, codex: codex.getStatus() });
    return;
  }

  if (route === 'POST /api/codex/restart') {
    codex.stop();
    codex = createClient();
    wireClient(codex);
    await codex.ensureStarted();
    publish({ type: 'codex.restarted', receivedAt: new Date().toISOString() });
    sendJson(res, 200, { ok: true, codex: codex.getStatus() });
    return;
  }

  if (route === 'GET /api/events') {
    openSse(res, null);
    return;
  }

  if (route === 'GET /api/sessions') {
    sendJson(res, 200, { data: visibleSessions(req).map(summarySession) });
    return;
  }

  if (route === 'GET /api/mobile/bootstrap') {
    await mobileBootstrap(req, res);
    return;
  }

  if (route === 'GET /api/mobile/events') {
    openMobileEventsSse(res);
    return;
  }

  if (route === 'GET /api/mobile/push-public-key') {
    sendJson(res, 200, { push: pushNotifications.publicInfo() });
    return;
  }

  if (route === 'POST /api/mobile/push-subscriptions') {
    await mobilePushSubscribe(req, res);
    return;
  }

  if (route === 'POST /api/mobile/push-subscriptions/status') {
    await mobilePushStatus(req, res);
    return;
  }

  if (route === 'DELETE /api/mobile/push-subscriptions') {
    await mobilePushUnsubscribe(req, res);
    return;
  }

  if (route === 'POST /api/mobile/push/test') {
    await mobilePushTest(req, res);
    return;
  }

  if (route === 'POST /api/mobile/push/notify') {
    await mobilePushNotify(req, res);
    return;
  }

  if (route === 'POST /api/mobile/push/diagnostics') {
    await mobilePushDiagnostics(req, res);
    return;
  }

  const mobileProjectSessionsMatch = url.pathname.match(/^\/api\/mobile\/projects\/([^/]+)\/sessions$/);
  if (req.method === 'GET' && mobileProjectSessionsMatch) {
    await mobileProjectSessions(req, res, decodeURIComponent(mobileProjectSessionsMatch[1]));
    return;
  }

  const mobileSessionMatch = url.pathname.match(/^\/api\/mobile\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && mobileSessionMatch) {
    await mobileSessionDetail(req, res, decodeURIComponent(mobileSessionMatch[1]), url);
    return;
  }

  if (route === 'POST /api/mobile/chat') {
    await mobileChatStream(req, res);
    return;
  }

  // ===== Codex 原生历史：项目 / 历史对话 / 进入续聊（只读扫描 ~/.codex/sessions） =====
  if (route === 'GET /api/projects') {
    sendJson(res, 200, { data: await history.listProjects() });
    return;
  }

  const projectThreadsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/threads$/);
  if (req.method === 'GET' && projectThreadsMatch) {
    const result = await history.listThreads(decodeURIComponent(projectThreadsMatch[1]));
    sendJson(res, 200, result);
    return;
  }

  const threadDetailMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (req.method === 'GET' && threadDetailMatch) {
    const thread = await history.getThread(decodeURIComponent(threadDetailMatch[1]));
    sendJson(res, 200, { thread });
    return;
  }

  const threadResumeMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/resume$/);
  if (req.method === 'POST' && threadResumeMatch) {
    await resumeNativeThread(req, res, decodeURIComponent(threadResumeMatch[1]));
    return;
  }

  if (route === 'GET /api/apps') {
    sendJson(res, 200, { data: apps.list() });
    return;
  }

  if (route === 'POST /api/apps') {
    const body = await readJsonBody(req);
    const app = await apps.createFromGlobal({
      globalCodexConfig: config.codex,
      name: body.name,
    });
    await persistState();
    publish({ type: 'bridge.app.created', app, receivedAt: new Date().toISOString() });
    sendJson(res, 201, { app });
    return;
  }

  if (route === 'POST /api/uploads/images') {
    await uploadImage(req, res);
    return;
  }

  if (route === 'POST /api/sessions') {
    await createSession(req, res);
    return;
  }

  if (route === 'POST /api/chat') {
    await chatStream(req, res);
    return;
  }

  if (route === 'POST /api/complete') {
    await completeTask(req, res, url);
    return;
  }

  if (route === 'GET /api/models') {
    await codex.ensureStarted();
    const includeHidden = url.searchParams.get('includeHidden') === '1';
    const result = await codex.request('model/list', { limit: 100, includeHidden });
    sendJson(res, 200, result);
    return;
  }

  if (route === 'GET /api/account') {
    await codex.ensureStarted();
    const result = await codex.request('account/read', { refreshToken: false });
    sendJson(res, 200, result);
    return;
  }

  if (route === 'POST /api/account/login/start') {
    await codex.ensureStarted();
    const body = await readJsonBody(req);
    const result = await codex.request('account/login/start', body);
    sendJson(res, 200, result);
    return;
  }

  if (route === 'GET /api/rate-limits') {
    await codex.ensureStarted();
    const result = await codex.request('account/rateLimits/read', {});
    sendJson(res, 200, result);
    return;
  }

  if (route === 'GET /api/server-requests') {
    sendJson(res, 200, { data: codex.listServerRequests() });
    return;
  }

  const serverRequestMatch = url.pathname.match(/^\/api\/server-requests\/([^/]+)\/respond$/);
  if (req.method === 'POST' && serverRequestMatch) {
    const body = await readJsonBody(req);
    codex.respondToServerRequest(serverRequestMatch[1], body);
    sendJson(res, 200, { ok: true });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (sessionMatch) {
    await handleSessionRoute(req, res, url, sessionMatch[1], sessionMatch[2] || '');
    return;
  }

  const appMatch = url.pathname.match(/^\/api\/apps\/([^/]+)$/);
  if (appMatch) {
    await handleAppRoute(req, res, appMatch[1]);
    return;
  }

  const doc = apiDocumentation();
  if (route === 'GET /api') {
    sendJson(res, 200, doc);
    return;
  }

  const error = new Error(`未找到 API：${route}`);
  error.statusCode = 404;
  throw error;
}

const MOBILE_PROMPTS = [
  { id: 'project-summary', text: '用 5 条要点总结当前项目结构，并指出我下一步最该看哪些文件。' },
  { id: 'recent-risk', text: '查看这段会话上下文，帮我提炼目前最大的工程风险和下一步动作。' },
  { id: 'image-output', text: '给当前项目设计一张手机端启动页视觉草图。', mode: 'image' },
];

async function mobileBootstrap(req, res) {
  const projects = await history.listProjects();
  const defaultSession = await resolveDefaultMobileSession(projects);
  const mobileProjects = orderMobileProjects(projects, defaultSession);
  sendJson(res, 200, {
    ok: true,
    prompts: MOBILE_PROMPTS,
    projects: mobileProjects,
    defaultSession,
    bridge: {
      cwd: config.codex.cwd,
      model: config.codex.model,
      appId: req.access?.appId ?? null,
    },
    push: pushNotifications.publicInfo(),
  });
  warmDefaultMobileSession(defaultSession, req.access?.appId ?? null).catch((error) => {
    publish({ type: 'bridge.mobile.prewarm.error', error: error.message, receivedAt: new Date().toISOString() });
  });
}

async function mobileProjectSessions(req, res, projectId) {
  void req;
  const result = await history.listThreads(projectId);
  sendJson(res, 200, {
    project: result.project,
    sessions: result.data.map((thread) => mobileThreadSummary(thread, result.project)),
    truncated: result.truncated,
  });
}

async function mobileSessionDetail(req, res, sessionId, url) {
  void req;
  const session = await getMobileSession(sessionId, { source: url?.searchParams?.get('source') || '' });
  sendJson(res, 200, { session });
}

async function mobilePushSubscribe(req, res) {
  const body = await readJsonBody(req);
  const record = pushNotifications.upsert({
    subscription: body.subscription || body,
    appId: req.access?.scope === 'app' ? req.access.appId : body.appId || null,
    deviceName: body.deviceName || '',
    userAgent: req.headers['user-agent'] || '',
  });
  await persistState();
  sendJson(res, 201, { ok: true, subscription: record, push: pushNotifications.publicInfo() });
}

async function mobilePushUnsubscribe(req, res) {
  const body = await readJsonBody(req);
  const removed = pushNotifications.remove({ id: body.id, endpoint: body.endpoint });
  await persistState();
  sendJson(res, 200, { ok: true, removed, push: pushNotifications.publicInfo() });
}

async function mobilePushStatus(req, res) {
  const body = await readJsonBody(req);
  const endpoint = String(body.endpoint || '').trim();
  const subscription = pushNotifications.find({ endpoint });
  const appId = req.access?.scope === 'app' ? req.access.appId : null;
  const matchesScope = subscription && (!appId || !subscription.appId || subscription.appId === appId);
  const registered = Boolean(subscription?.enabled !== false && matchesScope);
  sendJson(res, 200, {
    ok: true,
    registered,
    subscription: registered ? subscription : null,
    push: pushNotifications.publicInfo(),
  });
}

async function mobilePushTest(req, res) {
  const body = await readJsonBody(req);
  const result = await pushNotifications.notifyAll(
    buildCompletionPayload({
      title: 'Codex 通知已开启',
      body: '以后电脑 Codex 回复完成会提醒你。',
      url: buildMobileSessionUrl(req, body.sessionId || ''),
      sessionId: body.sessionId || '',
    }),
    { appId: req.access?.scope === 'app' ? req.access.appId : null },
  );
  await persistState();
  sendJson(res, 200, { ok: true, result });
}

async function mobilePushNotify(req, res) {
  const body = await readJsonBody(req);
  const sessionId = String(body.sessionId || body.threadId || '').trim();
  const result = await pushNotifications.notifyAll(
    buildCompletionPayload({
      title: body.title || 'Codex 回复完成',
      body: body.body || body.message || '电脑 Codex 有新回复，点开继续会话。',
      url: body.url || buildMobileSessionUrl(req, sessionId),
      sessionId,
    }),
    { appId: req.access?.scope === 'app' ? req.access.appId : null },
  );
  await persistState();
  sendJson(res, 200, { ok: true, result });
}

async function mobilePushDiagnostics(req, res) {
  const body = await readJsonBody(req);
  const event = {
    type: 'bridge.mobile.push.diagnostics',
    stage: String(body.stage || '').slice(0, 60),
    status: String(body.status || '').slice(0, 60),
    message: String(body.message || '').slice(0, 300),
    rawMessage: String(body.rawMessage || '').slice(0, 300),
    name: String(body.name || '').slice(0, 80),
    code: body.code ?? null,
    permission: String(body.permission || '').slice(0, 40),
    hasServiceWorker: Boolean(body.hasServiceWorker),
    hasPushManager: Boolean(body.hasPushManager),
    hasNotification: Boolean(body.hasNotification),
    standalone: Boolean(body.standalone),
    appIdScope: req.access?.scope || null,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 260),
    receivedAt: new Date().toISOString(),
  };
  publish(event);
  console.warn('[mobile-push-diagnostics]', JSON.stringify(event));
  sendJson(res, 200, { ok: true });
}

async function mobileChatStream(req, res) {
  const body = await readJsonBody(req);
  const text = String(body.text ?? body.prompt ?? '').trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const hasStructuredInput = Array.isArray(body.input) && body.input.length > 0;
  if (!text && attachments.length === 0 && !hasStructuredInput) {
    const error = new Error('请输入文字或上传附件');
    error.statusCode = 400;
    throw error;
  }

  const appId = req.access?.scope === 'app' ? req.access.appId : body.appId || null;
  const app = appId ? apps.get(appId) : null;
  const target = await resolveMobileChatTarget(body, appId);
  const uploadRoot = app?.workspaceRoot || path.join(projectRoot, 'data');
  const files = await materializeMobileAttachments({ attachments, root: uploadRoot });
  const input = [
    ...toAppServerInput(
      buildMobileCodexInput({
        text,
        files,
        imageMode: body.mode === 'image' || body.output === 'image',
      }),
    ),
    ...extraMobileInput(body, text),
  ];

  await codex.ensureStarted();
  const request = {
    appId,
    name: target.title || text.slice(0, 34) || config.ui.defaultSessionName,
    cwd: target.executionProfile.cwd,
    model: target.executionProfile.model ?? config.codex.model,
    effort: target.executionProfile.effort ?? config.codex.effort,
    speed: body.speed ?? config.codex.speed,
    approvalPolicy: target.executionProfile.approvalPolicy,
    sandbox: sandboxModeFromPolicy(target.executionProfile.sandboxPolicy),
    sandboxPolicy: target.executionProfile.sandboxPolicy,
    permissionProfile: target.executionProfile.permissionProfile,
    executionProfile: target.executionProfile,
    serviceName: config.codex.serviceName,
    ephemeral: false,
    experimentalRawEvents: config.codex.experimentalRawEvents,
    persistExtendedHistory: true,
  };

  let session;
  if (target.threadId) {
    const result = await codex.request('thread/resume', {
      threadId: target.threadId,
      ...threadExecutionParams(target.executionProfile),
      approvalPolicy: request.approvalPolicy,
      model: request.model,
      persistExtendedHistory: true,
      excludeTurns: false,
    });
    session = store.upsertResumedSession({ thread: result.thread, request, config });
    session.cwd = target.executionProfile.cwd;
    if (appId && !session.appId) session.appId = appId;
  } else {
    const result = await codex.request('thread/start', {
      model: request.model,
      ...threadExecutionParams(target.executionProfile),
      approvalPolicy: request.approvalPolicy,
      serviceName: request.serviceName,
      ephemeral: request.ephemeral,
      experimentalRawEvents: request.experimentalRawEvents,
      persistExtendedHistory: request.persistExtendedHistory,
    });
    session = store.createSession({ thread: result.thread, request, config });
  }

  await persistState();
  publish({
    type: target.threadId ? 'bridge.session.resumed' : 'bridge.session.created',
    session: summarySession(session),
    receivedAt: new Date().toISOString(),
  });
  await streamTurn(req, res, session, { ...body, appId, input, model: request.model, effort: request.effort }, { created: !target.threadId });
}

async function resolveDefaultMobileSession(projects) {
  const latestBridge = pickLatestBridgeSession(null);
  const sortedProjects = [...projects]
    .filter((project) => project.conversationCount > 0)
    .sort((a, b) => toTime(b.lastActivity) - toTime(a.lastActivity));
  let latestNative = null;
  for (const project of sortedProjects.slice(0, 8)) {
    latestNative = await latestNativeThread(project);
    if (latestNative) break;
  }

  if (latestBridge && (!latestNative || toTime(latestBridge.updatedAt) >= toTime(latestNative.updatedAt || latestNative.startedAt))) {
    return mobileBridgeSession(latestBridge);
  }
  if (latestNative) {
    return mobileNativeSession(await history.getThread(latestNative.id));
  }
  return null;
}

async function warmDefaultMobileSession(defaultSession, appId) {
  if (!defaultSession?.id) {
    return null;
  }
  const existing = mobileWarmups.get(defaultSession.id);
  if (existing) {
    return existing;
  }
  const warmup = prepareDefaultMobileSession(defaultSession, appId).catch((error) => {
    mobileWarmups.delete(defaultSession.id);
    throw error;
  });
  mobileWarmups.set(defaultSession.id, warmup);
  return warmup;
}

async function prepareDefaultMobileSession(defaultSession, appId) {
  await codex.ensureStarted();
  let session = store.get(defaultSession.id);
  let executionProfile = session?.executionProfile || null;
  if (!executionProfile && defaultSession.id) {
    executionProfile = await history.getThreadExecutionProfile(defaultSession.id);
  }
  if (!executionProfile) {
    return;
  }
  const result = await codex.request('thread/resume', {
    threadId: defaultSession.id,
    ...threadExecutionParams(executionProfile),
    approvalPolicy: executionProfile.approvalPolicy,
    model: executionProfile.model ?? config.codex.model,
    persistExtendedHistory: true,
    excludeTurns: false,
  });
  session = store.upsertResumedSession({
    thread: result.thread,
    request: {
      cwd: executionProfile.cwd,
      executionProfile,
      appId: appId || session?.appId || null,
      name: defaultSession.title || defaultSession.projectName || defaultSession.id,
    },
    config,
  });
  session.cwd = executionProfile.cwd;
  if (appId && !session.appId) session.appId = appId;
  await persistState();
  prewarmSession(session);
  return session;
}

async function prewarmStartupMobileDefault() {
  try {
    const projects = await history.listProjects();
    const defaultSession = await resolveDefaultMobileSession(projects);
    await warmDefaultMobileSession(defaultSession, null);
  } catch (error) {
    publish({ type: 'bridge.mobile.startupPrewarm.error', error: error.message, receivedAt: new Date().toISOString() });
  }
}

async function latestNativeThread(project) {
  try {
    const result = await history.listThreads(project.id);
    const thread = result.data?.[0];
    return thread ? { ...thread, project } : null;
  } catch {
    return null;
  }
}

function pickLatestBridgeSession(project = null) {
  const sessions = store
    .list()
    .filter((session) => session.status !== 'archived')
    .filter((session) => !project || isPathUnder(session.cwd, project.path));
  return sessions.find((session) => session.messages.length > 0) || sessions[0] || null;
}

async function getMobileSession(sessionId, { source = '' } = {}) {
  return resolveMobileSessionView(sessionId, {
    source,
    store,
    history,
    toBridgeSession: mobileBridgeSession,
    toNativeSession: mobileNativeSession,
  });
}

async function resolveMobileChatTarget(body, appId) {
  const sessionId = String(body.sessionId || body.threadId || '').trim();
  if (sessionId) {
    const bridgeSession = store.get(sessionId);
    if (bridgeSession) {
      const executionProfile = await resolveExecutionProfileForSession(bridgeSession);
      return {
        threadId: bridgeSession.threadId,
        session: bridgeSession,
        cwd: executionProfile.cwd,
        title: bridgeSession.name,
        created: false,
        source: 'bridge',
        executionProfile,
      };
    }
    const executionProfile = await history.getThreadExecutionProfile(sessionId);
    if (!executionProfile) {
      const error = new Error(`未知 session：${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    const session = store.upsertResumedSession({
      thread: { id: sessionId, sessionId },
      request: {
        cwd: executionProfile.cwd,
        executionProfile,
        appId,
        name: executionProfile.projectName || sessionId,
      },
      config,
    });
    session.cwd = executionProfile.cwd;
    session.appId ||= appId;
    return {
      threadId: sessionId,
      session,
      cwd: executionProfile.cwd,
      title: executionProfile.projectName,
      created: false,
      source: 'codex-history',
      executionProfile,
    };
  }

  const executionProfile = await resolveMobileProjectExecutionProfile(body);
  return {
    threadId: null,
    session: null,
    cwd: executionProfile.cwd,
    title: body.title || null,
    created: true,
    source: 'new',
    executionProfile,
  };
}

async function resolveMobileProjectExecutionProfile(body) {
  if (body.projectId) {
    const profile = await history.getProjectExecutionProfile(body.projectId);
    if (profile) return profile;
  }
  const error = new Error('无法解析桌面端执行权限状态。请先在 Windows Codex App 中打开该项目或选择已有桌面会话后再从手机发送。');
  error.statusCode = 409;
  error.code = 'execution_profile_unresolved';
  throw error;
}

async function resolveExecutionProfileForSession(session, { allowBridgeDefaults = false } = {}) {
  if (isCompleteExecutionProfile(session.executionProfile)) {
    return session.executionProfile;
  }
  const profile = await history.getThreadExecutionProfile(session.threadId || session.id);
  if (profile) {
    session.executionProfile = profile;
    session.cwd = profile.cwd;
    session.approvalPolicy = profile.approvalPolicy;
    session.sandboxPolicy = profile.sandboxPolicy;
    session.permissionProfile = profile.permissionProfile;
    session.workspaceRoots = profile.workspaceRoots;
    session.sandbox = sandboxModeFromPolicy(profile.sandboxPolicy) || session.sandbox;
    return profile;
  }
  if (allowBridgeDefaults) {
    return sessionExecutionProfileFromBridgeDefaults(session);
  }
  const error = new Error('无法解析桌面端执行权限状态。请从 Codex 桌面端打开一次该会话后再从手机继续。');
  error.statusCode = 409;
  error.code = 'execution_profile_unresolved';
  throw error;
}

function mobileBridgeSession(session) {
  return {
    id: session.id,
    threadId: session.threadId,
    source: 'bridge',
    title: session.name || projectNameFromPath(session.cwd) || session.id,
    cwd: session.cwd,
    projectName: projectNameFromPath(session.cwd),
    updatedAt: session.updatedAt,
    needsResume: true,
    messages: bridgeSessionMessages(session),
  };
}

function mobileNativeSession(thread) {
  return {
    id: thread.id,
    threadId: thread.id,
    source: 'codex-history',
    title: thread.title || thread.projectName || '对话',
    cwd: thread.cwd,
    projectId: thread.projectId,
    projectName: thread.projectName,
    startedAt: thread.startedAt,
    updatedAt: thread.updatedAt || thread.startedAt,
    needsResume: true,
    messages: (thread.messages || []).map((message) => ({
      role: message.role,
      text: stripHiddenCodexDirectives(message.text || '').text,
      status: 'done',
      at: message.at || null,
    })),
  };
}

function mobileThreadSummary(thread, project) {
  return {
    id: thread.id,
    threadId: thread.id,
    title: thread.title || '(无标题对话)',
    preview: thread.preview || '',
    cwd: thread.cwd,
    startedAt: thread.startedAt,
    updatedAt: thread.updatedAt || thread.startedAt,
    source: 'codex-history',
    project: project ? { id: project.id, name: project.name, path: project.path } : null,
  };
}

function pickProjectForCwd(projects, cwd) {
  const cwdNorm = normPath(cwd);
  let best = null;
  let bestLen = -1;
  for (const project of projects || []) {
    const projectNorm = normPath(project.path);
    if (!projectNorm) continue;
    if (cwdNorm === projectNorm || cwdNorm.startsWith(`${projectNorm}\\`)) {
      if (projectNorm.length > bestLen) {
        best = project;
        bestLen = projectNorm.length;
      }
    }
  }
  return best;
}

function isPathUnder(child, parent) {
  const childNorm = normPath(child);
  const parentNorm = normPath(parent);
  return Boolean(childNorm && parentNorm && (childNorm === parentNorm || childNorm.startsWith(`${parentNorm}\\`)));
}

function normPath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function projectNameFromPath(value) {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || '';
}

function toTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function isCompleteExecutionProfile(profile) {
  return Boolean(
    profile?.cwd &&
      profile?.approvalPolicy &&
      profile?.sandboxPolicy?.type &&
      profile?.permissionProfile?.type,
  );
}

function sessionExecutionProfileFromBridgeDefaults(session) {
  const profile = {
    source: 'bridge-admin-default',
    threadId: session.threadId || session.id,
    cwd: session.cwd || config.codex.cwd,
    workspaceRoots: session.cwd ? [session.cwd] : [],
    approvalPolicy: session.approvalPolicy || config.codex.approvalPolicy,
    sandboxPolicy: sandboxPolicyFromMode(session.sandbox || config.codex.sandbox),
    permissionProfile: session.permissionProfile || { type: 'managed' },
    model: session.model ?? config.codex.model,
    effort: session.effort ?? config.codex.effort,
  };
  session.executionProfile = profile;
  session.sandboxPolicy = profile.sandboxPolicy;
  session.permissionProfile = profile.permissionProfile;
  session.workspaceRoots = profile.workspaceRoots;
  return profile;
}

async function createSession(req, res) {
  await codex.ensureStarted();
  const body = await readJsonBody(req);
  if (req.access?.scope === 'app') {
    body.appId ||= req.access.appId;
  }
  const app = body.appId ? apps.require(body.appId) : null;
  const request = normalizeSessionRequest(body, app);
  // cwd 放行规则：app key 只能指到“已知项目根”（防远端把任意路径当可写工作目录）；
  // 本机/admin 额外允许任何真实存在的目录（如复盘日记目录，用于工作台「继续聊这一天」）。
  if (body.cwd) {
    if (await history.isProjectRoot(body.cwd)) {
      request.cwd = body.cwd;
    } else if (req.access?.scope === 'admin' && (await isExistingDirectory(body.cwd))) {
      request.cwd = body.cwd;
    }
  }
  const result = await codex.request('thread/start', {
    model: request.model,
    cwd: request.cwd,
    approvalPolicy: request.approvalPolicy,
    sandbox: request.sandbox,
    serviceName: request.serviceName,
    ephemeral: request.ephemeral,
    experimentalRawEvents: request.experimentalRawEvents,
    persistExtendedHistory: request.persistExtendedHistory,
  });
  const session = store.createSession({ thread: result.thread, request, config });
  await persistState();
  publish({ type: 'bridge.session.created', session: summarySession(session), receivedAt: new Date().toISOString() });
  sendJson(res, 201, { session });
  // 后台预热：把“新线程首轮 ~10s 的连接+前缀缓存”提前焐热，挪出用户首句的关键路径。
  prewarmSession(session);
}

// 进入一条原生历史对话续聊：用 rollout 的 id 作为 threadId 调 thread/resume，
// 在该对话的真实 cwd 里恢复线程，并登记进 session store（让后续 /api/sessions/:id/turns 能用）。
async function resumeNativeThread(req, res, threadId) {
  await codex.ensureStarted();
  const body = await readJsonBody(req);
  const executionProfile = await history.getThreadExecutionProfile(threadId);
  if (!executionProfile) {
    const error = new Error(`未找到历史对话：${threadId}`);
    error.statusCode = 404;
    throw error;
  }
  const existing = store.get(threadId);
  const result = await codex.request('thread/resume', {
    threadId,
    ...threadExecutionParams(executionProfile),
    approvalPolicy: executionProfile.approvalPolicy,
    model: executionProfile.model ?? config.codex.model,
    persistExtendedHistory: true,
    excludeTurns: false,
  });
  const claimedAppId = body.appId ?? (req.access?.scope === 'app' ? req.access.appId : null) ?? existing?.appId ?? null;
  const request = {
    cwd: executionProfile.cwd,
    executionProfile,
    name: existing?.name || executionProfile.projectName || threadId,
    appId: claimedAppId,
  };
  const session = store.upsertResumedSession({ thread: result.thread, request, config });
  // upsert 不改既有会话的 cwd/appId，这里显式落实：手机端 appId 认领该会话，cwd 用历史真实目录。
  session.cwd = executionProfile.cwd;
  session.appId = claimedAppId;
  await persistState();
  publish({ type: 'bridge.session.resumed', session: summarySession(session), receivedAt: new Date().toISOString() });
  sendJson(res, 200, { session: summarySession(session) });
}

async function handleAppRoute(req, res, appId) {
  if (req.method === 'GET') {
    sendJson(res, 200, { app: apps.require(appId) });
    return;
  }

  if (req.method === 'PUT') {
    const body = await readJsonBody(req);
    const app = apps.update(appId, body);
    await persistState();
    publish({ type: 'bridge.app.updated', app, receivedAt: new Date().toISOString() });
    sendJson(res, 200, { app });
    return;
  }

  if (req.method === 'DELETE') {
    const app = apps.remove(appId);
    await persistState();
    publish({ type: 'bridge.app.deleted', appId, receivedAt: new Date().toISOString() });
    sendJson(res, 200, { ok: true, app });
    return;
  }

  const error = new Error(`未知 app API：${req.method} /api/apps/${appId}`);
  error.statusCode = 404;
  throw error;
}

async function handleSessionRoute(req, res, url, sessionId, action) {
  const session = store.require(sessionId);
  assertSessionAccess(req, session);

  if (req.method === 'GET' && !action) {
    sendJson(res, 200, { session });
    return;
  }

  if (req.method === 'POST' && action === 'resume') {
    await codex.ensureStarted();
    const body = await readJsonBody(req);
    const executionProfile = await resolveExecutionProfileForSession(session, { allowBridgeDefaults: req.access?.scope === 'admin' });
    const result = await codex.request('thread/resume', {
      threadId: session.threadId,
      ...threadExecutionParams(executionProfile),
      approvalPolicy: executionProfile.approvalPolicy,
      model: body.model ?? executionProfile.model ?? session.model,
      persistExtendedHistory: true,
      excludeTurns: false,
    });
    const resumed = store.upsertResumedSession({ thread: result.thread, request: { ...body, executionProfile }, config });
    await persistState();
    sendJson(res, 200, { session: resumed });
    return;
  }

  if (req.method === 'GET' && action === 'events') {
    openSse(res, sessionId);
    return;
  }

  if (req.method === 'GET' && action === 'files') {
    await serveSessionFile(req, res, url, session);
    return;
  }

  if (req.method === 'POST' && action === 'turns') {
    const wantsStream =
      url.searchParams.get('stream') === '1' ||
      String(req.headers.accept || '').toLowerCase().includes('text/event-stream');
    if (wantsStream) {
      const body = await readJsonBody(req);
      await streamTurn(req, res, session, body, { created: false });
      return;
    }
    await startTurn(req, res, url, sessionId);
    return;
  }

  if (req.method === 'POST' && action === 'interrupt') {
    if (!session.activeTurnId) {
      sendJson(res, 200, { ok: true, skipped: true, reason: 'session 没有正在运行的 turn' });
      return;
    }
    const result = await codex.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });
    await persistState();
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === 'POST' && action === 'steer') {
    const body = await readJsonBody(req);
    if (!session.activeTurnId) {
      const error = new Error('session 没有正在运行的 turn，无法 steer');
      error.statusCode = 409;
      throw error;
    }
    const input = normalizeInput(body);
    const result = await codex.request('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: session.activeTurnId,
      input,
    });
    store.addUserMessage(session, { input, turnId: session.activeTurnId });
    await persistState();
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === 'POST' && action === 'archive') {
    const result = await codex.request('thread/archive', { threadId: session.threadId });
    session.status = 'archived';
    await persistState();
    sendJson(res, 200, { ok: true, result });
    return;
  }

  const error = new Error(`未知 session API：${req.method} ${url.pathname}`);
  error.statusCode = 404;
  throw error;
}

async function startTurn(req, res, url, sessionId) {
  await codex.ensureStarted();
  const session = store.require(sessionId);
  assertSessionAccess(req, session);
  const body = await readJsonBody(req);
  const input = normalizeInput(body);
  const executionProfile = await resolveExecutionProfileForSession(session, { allowBridgeDefaults: req.access?.scope === 'admin' });
  await settlePrewarm(session);
  const wait = url.searchParams.get('wait') === '1';
  const completionPromise = wait ? waitForTurnCompleted(session.threadId) : null;
  const result = await codex.request('turn/start', {
    threadId: session.threadId,
    input,
    approvalPolicy: executionProfile.approvalPolicy,
    ...turnExecutionParams(executionProfile),
    model: body.model ?? executionProfile.model ?? session.model,
    effort: body.effort ?? executionProfile.effort ?? session.effort,
    personality: body.personality,
    serviceTier: body.serviceTier,
    outputSchema: body.outputSchema,
    collaborationMode: body.collaborationMode,
  });

  store.addUserMessage(session, { input, turnId: result.turn.id });
  if (!session.turns.some((turn) => turn.id === result.turn.id)) {
    store.beginTurn(session, { turn: result.turn, input });
  }
  await persistState();
  publish({
    type: 'bridge.turn.started',
    sessionId: session.id,
    threadId: session.threadId,
    turnId: result.turn.id,
    receivedAt: new Date().toISOString(),
  });

  if (wait) {
    await completionPromise;
    sendJson(res, 200, { session: store.require(sessionId), turn: result.turn });
    return;
  }

  sendJson(res, 202, { session: summarySession(session), turn: result.turn });
}

// 高级接口：一个请求建会话 + 发第一轮 + 流式返回（无需先建会话、无需轮询）。
async function chatStream(req, res) {
  await codex.ensureStarted();
  const body = await readJsonBody(req);
  if (req.access?.scope === 'app') {
    body.appId ||= req.access.appId;
  }
  const app = body.appId ? apps.require(body.appId) : null;
  const request = normalizeSessionRequest(body, app);
  // 允许在某个“已知项目根”里新建对话（手机端「在此项目新建」）。只接受历史里出现过的项目根，
  // 避免把任意路径作为可写工作目录。
  if (body.cwd && (await history.isProjectRoot(body.cwd))) {
    request.cwd = body.cwd;
  }
  const result = await codex.request('thread/start', {
    model: request.model,
    cwd: request.cwd,
    approvalPolicy: request.approvalPolicy,
    sandbox: request.sandbox,
    serviceName: request.serviceName,
    ephemeral: request.ephemeral,
    experimentalRawEvents: request.experimentalRawEvents,
    persistExtendedHistory: request.persistExtendedHistory,
  });
  const session = store.createSession({ thread: result.thread, request, config });
  await persistState();
  publish({ type: 'bridge.session.created', session: summarySession(session), receivedAt: new Date().toISOString() });
  await streamTurn(req, res, session, body, { created: true });
}

// 在一个 session 上发一轮，并只把这一轮的输出以类型化 SSE 流式返回（无 30 条回放、无整 session 重负载）。
// 关键：监听器必须在 await turn/start 之前挂上，否则会漏掉开头的 delta（bus 是同步 EventEmitter）。
async function streamTurn(req, res, session, body, { created = false } = {}) {
  await codex.ensureStarted();
  // 先把可能在跑的预热轮收尾（让出线程），且必须在挂 bus 监听器之前，
  // 否则预热轮被打断时的 turn/completed 会被这条流误当成真实轮的完成。
  await settlePrewarm(session);
  const input = normalizeInput(body);
  const appId = session.appId || (req.access?.scope === 'app' ? req.access.appId : null);
  const baseUrl = requestBaseUrl(req);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  writeTypedSse(res, 'session', {
    sessionId: session.id,
    threadId: session.threadId,
    appId: session.appId,
    model: session.model,
    cwd: session.cwd,
    created,
  });

  let finished = false;
  let activeTurnId = null;
  let assistantText = '';
  let seq = 0;
  let heartbeat = null;
  let safety = null;
  const directiveFilter = createHiddenCodexDirectiveStreamFilter();
  const emittedImages = new Set();
  const imageScans = [];

  function scanImages(text, turnId) {
    for (const absPath of extractWorkspaceImagePaths(text, session.cwd)) {
      if (emittedImages.has(absPath)) {
        continue;
      }
      emittedImages.add(absPath);
      imageScans.push(
        buildImageEvent(session, absPath, appId, turnId, baseUrl)
          .then((event) => {
            if (event && !finished) {
              writeTypedSse(res, 'image', event);
            }
          })
          .catch(() => {}),
      );
    }
  }

  function cleanup() {
    bus.off('event', onEvent);
    clearInterval(heartbeat);
    clearTimeout(safety);
  }

  function finishStream(turn) {
    if (finished) {
      return;
    }
    const tail = directiveFilter.flush();
    if (tail) {
      assistantText += tail;
      writeTypedSse(res, 'delta', { turnId: turn?.id ?? activeTurnId, delta: tail, seq: seq++ });
    }
    finished = true;
    cleanup();
    scanImages(assistantText, turn?.id ?? activeTurnId);
    Promise.allSettled(imageScans).then(() => {
      const status = turn?.status === 'interrupted' ? 'interrupted' : 'completed';
      writeTypedSse(res, 'done', {
        turnId: turn?.id ?? activeTurnId,
        status,
        finalText: assistantText,
      });
      res.end();
      if (status === 'completed') {
        notifySessionComplete(req, session, assistantText, { appId }).catch((error) => {
          publish({ type: 'bridge.push.error', error: error.message, sessionId: session.id, receivedAt: new Date().toISOString() });
        });
      }
    });
  }

  function failStream(code, message) {
    if (finished) {
      return;
    }
    finished = true;
    cleanup();
    writeTypedSse(res, 'error', { code, message });
    res.end();
  }

  function onEvent(event) {
    if (finished || event.params?.threadId !== session.threadId) {
      return;
    }
    const params = event.params || {};
    if (event.method === 'item/agentMessage/delta') {
      if (activeTurnId && params.turnId && params.turnId !== activeTurnId) {
        return;
      }
      const delta = directiveFilter.push(params.delta ?? '');
      if (!delta) {
        return;
      }
      assistantText += delta;
      writeTypedSse(res, 'delta', { turnId: params.turnId ?? activeTurnId, delta, seq: seq++ });
    } else if (event.method === 'item/completed' && params.item?.type === 'agentMessage') {
      scanImages(stripHiddenCodexDirectives(params.item.text || '').text, params.turnId ?? activeTurnId);
    } else if (event.method === 'thread/tokenUsage/updated') {
      writeTypedSse(res, 'usage', { turnId: params.turnId ?? activeTurnId, tokenUsage: params.tokenUsage ?? params.usage ?? null });
    } else if (event.method === 'error' || event.method === 'warning') {
      // 把“连接中断/重连/回退 HTTPS”透传给调用方，让其知道这是网络连接超时，
      // 而非模型在思考或加载提示词。无法归类的 error 也兜底透传，避免静默卡住。
      const notice = classifyConnectionNotice(event.method, params);
      if (notice) {
        writeTypedSse(res, 'notice', { turnId: params.turnId ?? activeTurnId, at: new Date().toISOString(), ...notice });
      } else if (event.method === 'error') {
        writeTypedSse(res, 'notice', {
          turnId: params.turnId ?? activeTurnId,
          at: new Date().toISOString(),
          kind: 'error',
          severity: 'error',
          reason: 'codex_error',
          willRetry: params.willRetry === true,
          message: params?.error?.message || '模型服务返回错误',
          detail: params?.error?.additionalDetails || '',
        });
      }
    } else if (event.method === 'turn/completed') {
      const turn = params.turn || {};
      if (activeTurnId && turn.id && turn.id !== activeTurnId) {
        return;
      }
      finishStream(turn);
    }
  }

  bus.on('event', onEvent);
  heartbeat = setInterval(() => {
    if (!finished) {
      writeTypedSse(res, 'ping', { t: new Date().toISOString() });
    }
  }, 15000);
  safety = setTimeout(() => failStream('stream_timeout', '等待 turn 完成超时'), 10 * 60 * 1000);

  res.on('close', () => {
    if (finished) {
      return;
    }
    finished = true;
    cleanup();
    if (activeTurnId) {
      // 客户端断开就打断这一轮，别白烧 token。
      codex.request('turn/interrupt', { threadId: session.threadId, turnId: activeTurnId }).catch(() => {});
    }
  });

  let result;
  try {
    const executionProfile = await resolveExecutionProfileForSession(session, { allowBridgeDefaults: req.access?.scope === 'admin' });
    result = await codex.request('turn/start', {
      threadId: session.threadId,
      input,
      approvalPolicy: executionProfile.approvalPolicy,
      ...turnExecutionParams(executionProfile),
      model: body.model ?? executionProfile.model ?? session.model,
      effort: body.effort ?? executionProfile.effort ?? session.effort,
    });
  } catch (error) {
    failStream('turn_start_failed', error.message);
    return;
  }

  activeTurnId = result.turn.id;
  store.addUserMessage(session, { input, turnId: activeTurnId });
  if (!session.turns.some((turn) => turn.id === activeTurnId)) {
    store.beginTurn(session, { turn: result.turn, input });
  }
  schedulePersist();
  publish({
    type: 'bridge.turn.started',
    sessionId: session.id,
    threadId: session.threadId,
    turnId: activeTurnId,
    receivedAt: new Date().toISOString(),
  });
}

// ===== 无状态结构化补全 /api/complete =====
// 单次任务走 Codex SDK：不进入 app-server 的 thread/turn 管理，也不写 Bridge session。
// 它仍然复用桌面执行画像，避免手机/外部调用偷偷掉到 Bridge 默认 cwd/sandbox。
async function completeTask(req, res, url) {
  const body = await readJsonBody(req);

  if (req.access?.scope === 'app') {
    body.appId ||= req.access.appId;
  }

  const input = normalizeInput(body);
  const hasContent = input.some((item) => item.type !== 'text' || String(item.text || '').trim());
  if (!hasContent) {
    const error = new Error('complete 需要非空的 input / text / prompt');
    error.statusCode = 400;
    throw error;
  }

  const wantsStream =
    body.stream === true ||
    url.searchParams.get('stream') === '1' ||
    String(req.headers.accept || '').toLowerCase().includes('text/event-stream');

  const executionProfile = await resolveCompleteExecutionProfile(req, body);
  const ctx = {
    cwd: executionProfile.cwd,
    executionProfile,
    appId: body.appId || (req.access?.scope === 'app' ? req.access.appId : null),
    baseUrl: requestBaseUrl(req),
    input: toSdkInput(input),
    outputSchema: body.outputSchema,
    sdkOptions: sdkOptionsFromExecutionProfile(executionProfile),
  };

  if (wantsStream) {
    await streamSdkComplete(req, res, ctx);
  } else {
    await awaitSdkComplete(req, res, ctx);
  }
}

async function resolveCompleteExecutionProfile(req, body) {
  const sessionId = String(body.sessionId || body.threadId || '').trim();
  if (sessionId) {
    const session = store.get(sessionId);
    if (session) {
      return resolveExecutionProfileForSession(session, { allowBridgeDefaults: req.access?.scope === 'admin' });
    }
    const profile = await history.getThreadExecutionProfile(sessionId);
    if (profile) return profile;
  }

  if (body.projectId) {
    const profile = await history.getProjectExecutionProfile(body.projectId);
    if (profile) return profile;
  }

  if (req.access?.scope === 'admin') {
    const cwd = body.cwd && (await isExistingDirectory(body.cwd)) ? body.cwd : config.codex.cwd;
    return {
      source: 'bridge-admin-default',
      cwd,
      workspaceRoots: [cwd],
      approvalPolicy: body.approvalPolicy || config.codex.approvalPolicy,
      sandboxPolicy: body.sandboxPolicy || sandboxPolicyFromMode(body.sandbox || config.codex.sandbox),
      permissionProfile: { type: 'managed' },
      model: body.model ?? config.codex.model,
      effort: body.effort ?? config.codex.effort,
    };
  }

  const error = new Error('complete 缺少可用桌面执行画像，请传入 sessionId/threadId 或 projectId');
  error.statusCode = 409;
  error.code = 'execution_profile_unresolved';
  throw error;
}

function sdkOptionsFromExecutionProfile(profile) {
  const additionalDirectories = (profile.workspaceRoots || []).filter((root) => normPath(root) && normPath(root) !== normPath(profile.cwd));
  return {
    cwd: profile.cwd,
    model: profile.model ?? config.codex.model,
    effort: profile.effort ?? config.codex.effort,
    approvalPolicy: profile.approvalPolicy,
    sandboxPolicy: profile.sandboxPolicy,
    additionalDirectories,
  };
}

function toSdkInput(input) {
  return input.map((item) => {
    if (item.type === 'text') {
      return { type: 'text', text: String(item.text || '') };
    }
    if (item.type === 'localImage' || item.type === 'local_image') {
      return { type: 'local_image', path: item.path };
    }
    if (item.type === 'image' && item.url) {
      return { type: 'text', text: `图片 URL：${item.url}` };
    }
    return { type: 'text', text: JSON.stringify(item) };
  });
}

async function awaitSdkComplete(req, res, ctx) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  let result;
  try {
    result = await mobileRuntime.run(ctx.input, ctx.sdkOptions, {
      outputSchema: ctx.outputSchema ? toStrictJsonSchema(ctx.outputSchema) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    sendError(res, Object.assign(new Error(error.message || 'complete 失败'), { statusCode: 502 }));
    return;
  }
  const artifacts = await collectArtifacts(result.finalResponse, ctx);
  const payload = { status: 'completed', text: result.finalResponse, artifacts, usage: result.usage ?? null };
  if (ctx.outputSchema) {
    const parsed = tryParseJson(result.finalResponse);
    payload.parsed = parsed.ok ? parsed.value : null;
    if (!parsed.ok) payload.parseError = parsed.error;
  }
  sendJson(res, 200, payload);
}

async function streamSdkComplete(req, res, ctx) {
  const controller = new AbortController();
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const emit = (event, payload) => {
    if (!res.writableEnded) writeTypedSse(res, event, payload);
  };
  emit('start', { cwd: ctx.cwd, appId: ctx.appId, runtime: 'codex-sdk' });
  let seq = 0;
  let finalText = '';
  let usage = null;
  const itemTexts = new Map();
  const heartbeat = setInterval(() => emit('ping', { t: new Date().toISOString() }), 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) controller.abort();
  });

  try {
    const streamed = await mobileRuntime.runStreamed(ctx.input, ctx.sdkOptions, {
      outputSchema: ctx.outputSchema ? toStrictJsonSchema(ctx.outputSchema) : undefined,
      signal: controller.signal,
    });
    for await (const event of streamed.events) {
      if (event.type === 'thread.started') {
        emit('thread', { threadId: event.thread_id });
      } else if ((event.type === 'item.updated' || event.type === 'item.completed') && event.item?.type === 'agent_message') {
        const previous = itemTexts.get(event.item.id) || '';
        const text = stripHiddenCodexDirectives(event.item.text || '').text;
        const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
        itemTexts.set(event.item.id, text);
        finalText = text || finalText;
        if (delta) emit('delta', { delta, seq: seq++ });
      } else if (event.type === 'turn.completed') {
        usage = event.usage ?? null;
      } else if (event.type === 'turn.failed') {
        emit('error', { code: 'turn_failed', message: event.error?.message || 'complete 失败' });
        res.end();
        return;
      } else if (event.type === 'error') {
        emit('error', { code: 'sdk_error', message: event.message || 'complete 失败' });
        res.end();
        return;
      }
    }
    clearInterval(heartbeat);
    const artifacts = await collectArtifacts(finalText, ctx);
    for (const artifact of artifacts) emit('artifact', artifact);
    const donePayload = { status: 'completed', finalText, artifacts, usage };
    if (ctx.outputSchema) {
      const parsed = tryParseJson(finalText);
      donePayload.parsed = parsed.ok ? parsed.value : null;
      if (!parsed.ok) donePayload.parseError = parsed.error;
    }
    emit('done', donePayload);
    res.end();
  } catch (error) {
    clearInterval(heartbeat);
    emit('error', { code: 'sdk_error', message: error.message || 'complete 失败' });
    res.end();
  }
}

async function isExistingDirectory(rawPath) {
  try {
    return (await stat(String(rawPath))).isDirectory();
  } catch {
    return false;
  }
}

// 扫描助手文本里落在工作目录内的产物文件（目前是图片），返回 { type, path, fileName, mimeType, byteSize, dataUrl? }。
// 不绑 session：path 给本机直接读盘用；≤256KB 内联 dataUrl 方便远程客户端直接显示。
async function collectArtifacts(text, ctx) {
  const paths = extractWorkspaceImagePaths(text, ctx.cwd);
  const artifacts = [];
  for (const absPath of paths) {
    const artifact = await buildArtifact(absPath);
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

async function buildArtifact(absPath) {
  let info;
  try {
    info = await stat(absPath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size === 0) {
    return null;
  }
  const mimeType = contentType(absPath);
  const artifact = {
    type: 'image',
    path: absPath,
    fileName: path.basename(absPath),
    mimeType,
    byteSize: info.size,
  };
  if (info.size <= 256 * 1024) {
    try {
      const buffer = await readFile(absPath);
      artifact.dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch {
      // 内联失败不致命，path 仍可本地读取。
    }
  }
  return artifact;
}

// 用请求自身的协议+host 拼绝对地址：经隧道进来是 https://bridge.example.com，本机是 http://127.0.0.1:4555。
// 这样发给非局域网 App 的图片 url 可直接取用，不用客户端自己拼 base。
function requestBaseUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto ? String(forwardedProto).split(',')[0].trim() : 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${config.server.host}:${config.server.port}`;
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

function buildMobileSessionUrl(req, sessionId = '') {
  void req;
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  const query = params.toString();
  return `/m/index.htm${query ? `?${query}` : ''}`;
}

async function notifySessionComplete(req, session, text, { appId = null } = {}) {
  const result = await pushNotifications.notifyAll(
    buildCompletionPayload({
      title: 'Codex 回复完成',
      body: text ? String(text).replace(/\s+/g, ' ').trim() : '点开继续这个会话。',
      url: buildMobileSessionUrl(req, session.id),
      sessionId: session.id,
    }),
    { appId: appId || session.appId || null },
  );
  publish({
    type: 'bridge.push.sent',
    sessionId: session.id,
    result,
    receivedAt: new Date().toISOString(),
  });
  if (result.failed > 0) {
    await persistState();
  }
  return result;
}

async function buildImageEvent(session, absPath, appId, turnId, baseUrl) {
  let info;
  try {
    info = await stat(absPath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size === 0) {
    return null;
  }
  const mimeType = contentType(absPath);
  const params = new URLSearchParams({ path: absPath });
  if (appId) {
    params.set('appId', appId);
  }
  const event = {
    turnId,
    fileName: path.basename(absPath),
    mimeType,
    byteSize: info.size,
    url: `${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/files?${params.toString()}`,
  };
  if (info.size <= 256 * 1024) {
    try {
      const buffer = await readFile(absPath);
      event.dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch {
      // 内联失败不致命，url 仍可取图。
    }
  }
  return event;
}

async function uploadImage(req, res) {
  const body = await readJsonBody(req);
  const appId = resolveUploadAppId({ access: req.access, body, headers: req.headers });
  const app = apps.require(appId);
  const upload = await createImageUpload({
    app,
    fileName: body.fileName || body.name,
    mimeType: body.mimeType,
    base64: body.base64 || body.data,
  });
  sendJson(res, 201, { upload });
}

async function serveSessionFile(req, res, url, session) {
  const rawPath = url.searchParams.get('path') || '';
  const target = path.resolve(rawPath);
  if (!rawPath || !isPathInside(session.cwd, target)) {
    const error = new Error('文件路径不在当前 session 工作目录内');
    error.statusCode = 403;
    throw error;
  }
  await serveFile(res, target);
}

// ===== 新会话首轮预热（方案 A） =====
// codex 每个新线程的“首轮 ~10s”花在建立到模型后端的连接 + 处理/缓存大段静态前缀
// (AGENTS.md/技能/环境)上，且不跨线程复用。建会话后立刻在后台发一个一次性预热轮，把这笔
// 开销提前焐热；用户真正首句到达时，若预热已就绪则直接走热路径(~3s)，若还没好则打断预热、
// 按冷启动走(不比现状差)。预热轮登记为 ephemeral，不进入可见会话与历史。
const PREWARM_ENABLED = process.env.BRIDGE_PREWARM !== '0';
const PREWARM_INPUT = [
  { type: 'text', text: '（系统预热，无需理会：只回复一个字“好”，不要调用任何工具或读写文件）' },
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function prewarmSession(session) {
  if (!PREWARM_ENABLED || !session || session.ephemeral || session._prewarm) {
    return;
  }
  const marker = { turnId: null, warmReady: false, done: false, promise: null };
  session._prewarm = marker;
  session.prewarming = true;

  marker.promise = (async () => {
    let onNote = null;
    try {
      const result = await codex.request('turn/start', {
        threadId: session.threadId,
        input: PREWARM_INPUT,
        model: session.model,
        effort: 'low',
      });
      marker.turnId = result.turn.id;
      store.registerEphemeralTurn(marker.turnId); // 兜底：通知若早到已在 store 端登记

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        // 30s 还没结束（很可能撞上 WS 重连风暴）→ 强制打断，让线程尽快空出，
        // 避免“预热标记为 done 但 codex 线程仍占用、真实轮 turn/start 冲突”。
        const watchdog = setTimeout(() => {
          codex.request('turn/interrupt', { threadId: session.threadId, turnId: marker.turnId }).catch(() => {});
        }, 30000);
        // 极端兜底：始终等不到 turn/completed 也别永久挂着监听器。
        const backstop = setTimeout(() => {
          clearTimeout(watchdog);
          finish();
        }, 180000);
        onNote = (event) => {
          if (event.params?.threadId !== session.threadId) {
            return;
          }
          const tid = event.params?.turnId || event.params?.turn?.id;
          if (tid !== marker.turnId) {
            return;
          }
          if (event.method === 'item/agentMessage/delta' && !marker.warmReady) {
            // 出字即说明连接已通、前缀已被后端处理/缓存 —— 焐热达成，打断省 token。
            marker.warmReady = true;
            codex.request('turn/interrupt', { threadId: session.threadId, turnId: marker.turnId }).catch(() => {});
          }
          if (event.method === 'turn/completed') {
            clearTimeout(watchdog);
            clearTimeout(backstop);
            finish();
          }
        };
        codex.on('notification', onNote);
      });
    } catch {
      // 预热失败不影响正常使用。
    } finally {
      if (onNote) {
        codex.off('notification', onNote);
      }
      marker.done = true;
      session.prewarming = false;
    }
  })();
}

// 真实轮开始前调用：确保正在跑的预热轮已让出线程（codex 同一线程只允许一个活动 turn）。
async function settlePrewarm(session) {
  const marker = session?._prewarm;
  if (!marker || marker.done) {
    return;
  }
  // 等 turnId 就绪（turn/start 刚发出、响应未回时的极短窗口）。
  for (let i = 0; i < 60 && !marker.turnId && !marker.done; i += 1) {
    await delay(50);
  }
  if (marker.turnId && !marker.done) {
    await codex.request('turn/interrupt', { threadId: session.threadId, turnId: marker.turnId }).catch(() => {});
  }
  // 等预热轮真正结束（收到 turn/completed），线程空出后真实轮才能安全开始。
  await Promise.race([marker.promise, delay(8000)]).catch(() => {});
}

function waitForTurnCompleted(threadId, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.off('event', onEvent);
      reject(new Error('等待 turn 完成超时'));
    }, timeoutMs);

    function onEvent(event) {
      if (event.method !== 'turn/completed' || event.params?.threadId !== threadId) {
        return;
      }
      clearTimeout(timer);
      bus.off('event', onEvent);
      resolve(event);
    }

    bus.on('event', onEvent);
  });
}

function openSse(res, sessionId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const hello = {
    type: 'bridge.sse.connected',
    sessionId,
    bridge: publicConfig(),
    receivedAt: new Date().toISOString(),
  };
  writeSse(res, hello);

  const recent = sessionId ? store.require(sessionId).events.slice(-30) : store.events.slice(-30);
  for (const event of recent) {
    writeSse(res, { type: 'bridge.replay', event });
  }

  function onEvent(event) {
    const threadId = event.params?.threadId || event.sessionId;
    if (sessionId && threadId !== sessionId) {
      return;
    }
    writeSse(res, event);
  }

  bus.on('event', onEvent);
  const heartbeat = setInterval(() => {
    writeSse(res, { type: 'bridge.heartbeat', receivedAt: new Date().toISOString() });
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
    bus.off('event', onEvent);
  });
}

function openMobileEventsSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  writeSse(res, {
    type: 'bridge.mobile.sse.connected',
    receivedAt: new Date().toISOString(),
  });

  function onEvent(event) {
    if (event?.type !== 'bridge.mobile.unread') {
      return;
    }
    writeSse(res, event);
  }

  bus.on('event', onEvent);
  const heartbeat = setInterval(() => {
    writeSse(res, { type: 'bridge.mobile.heartbeat', receivedAt: new Date().toISOString() });
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
    bus.off('event', onEvent);
  });
}

function writeSse(res, payload) {
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// 类型化 SSE：用 event 名区分（session/delta/image/usage/done/error/ping），比裸 message 更好消费。
function writeTypedSse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function normalizeSessionRequest(body, app = null) {
  const baseCodex = resolveAppEffectiveCodexConfig({
    app,
    globalCodexConfig: config.codex,
  });

  return {
    appId: app?.appId ?? null,
    name: body.name,
    initialPrompt: body.initialPrompt,
    cwd: baseCodex.cwd,
    model: body.model ?? baseCodex.model,
    effort: body.effort ?? baseCodex.effort,
    speed: body.speed ?? baseCodex.speed,
    approvalPolicy: body.approvalPolicy || baseCodex.approvalPolicy,
    sandbox: body.sandbox || baseCodex.sandbox,
    serviceName: body.serviceName || baseCodex.serviceName,
    ephemeral: body.ephemeral ?? baseCodex.ephemeral,
    experimentalRawEvents: body.experimentalRawEvents ?? baseCodex.experimentalRawEvents,
    persistExtendedHistory: body.persistExtendedHistory ?? baseCodex.persistExtendedHistory,
  };
}

function normalizeInput(body) {
  if (Array.isArray(body.input)) {
    return body.input.map(normalizeInputItem);
  }
  return [
    {
      type: 'text',
      text: String(body.text ?? body.prompt ?? ''),
      text_elements: [],
    },
  ];
}

function extraMobileInput(body, text) {
  if (!Array.isArray(body.input)) {
    return [];
  }
  const seenText = String(text || '').trim();
  return body.input
    .map(normalizeInputItem)
    .filter((item) => {
      if (item.type !== 'text') return true;
      const value = String(item.text || '').trim();
      return value && value !== seenText;
    });
}

function normalizeInputItem(item) {
  if (item.type === 'text') {
    return { type: 'text', text: String(item.text ?? ''), text_elements: item.text_elements ?? [] };
  }
  return item;
}

function publicConfig() {
  return {
    bridgeId: config.bridgeId,
    version: config.version,
    startedAt: config.startedAt,
    server: config.server,
    codex: config.codex,
    apps: {
      count: apps.list().length,
    },
    ui: config.ui,
    security: publicSecurityConfig(config.security),
    api: apiDocumentation(),
  };
}

function visibleSessions(req) {
  return store.list();
}

function assertSessionAccess(req, session) {
  void req;
  void session;
}

function summarySession(session) {
  const lastMessage = session.messages.at(-1);
  return {
    id: session.id,
    threadId: session.threadId,
    appId: session.appId,
    codexSessionId: session.codexSessionId,
    name: session.name,
    status: session.status,
    runtimeStatus: session.runtimeStatus,
    cwd: session.cwd,
    model: session.model,
    effort: session.effort,
    speed: session.speed,
    sandbox: session.sandbox,
    approvalPolicy: session.approvalPolicy,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    activeTurnId: session.activeTurnId,
    messageCount: session.messages.length,
    turnCount: session.turns.length,
    eventCount: session.events.length,
    tokenUsage: session.tokenUsage,
    lastMessage: lastMessage
      ? {
          role: lastMessage.role,
          text: String(lastMessage.text || '').slice(0, 160),
          createdAt: lastMessage.createdAt,
          updatedAt: lastMessage.updatedAt,
        }
      : null,
  };
}

function apiDocumentation() {
  return {
    endpoints: [
      'GET /api/health',
      'GET /api/status',
      'GET /api/config',
      'GET /api/openapi.json',
      'PUT /api/config',
      'POST /api/codex/start',
      'POST /api/codex/restart',
      'GET /api/events',
      'GET /api/models',
      'GET /api/account',
      'POST /api/account/login/start',
      'GET /api/rate-limits',
      'GET /api/apps',
      'POST /api/apps',
      'GET /api/apps/:id',
      'PUT /api/apps/:id',
      'DELETE /api/apps/:id',
      'POST /api/uploads/images',
      'GET /api/server-requests',
      'POST /api/server-requests/:id/respond',
      'GET /api/mobile/bootstrap',
      'GET /api/mobile/events',
      'GET /api/mobile/projects/:id/sessions',
      'GET /api/mobile/sessions/:id',
      'POST /api/mobile/chat (SSE stream)',
      'GET /api/mobile/push-public-key',
      'POST /api/mobile/push-subscriptions',
      'POST /api/mobile/push-subscriptions/status',
      'DELETE /api/mobile/push-subscriptions',
      'POST /api/mobile/push/test',
      'POST /api/mobile/push/notify',
      'GET /api/sessions',
      'POST /api/sessions',
      'GET /api/projects',
      'GET /api/projects/:id/threads',
      'GET /api/threads/:id',
      'POST /api/threads/:id/resume',
      'POST /api/chat (SSE stream)',
      'POST /api/complete',
      'POST /api/complete?stream=1 (SSE stream)',
      'GET /api/sessions/:id',
      'POST /api/sessions/:id/resume',
      'GET /api/sessions/:id/events',
      'GET /api/sessions/:id/files?path=<local-path>',
      'POST /api/sessions/:id/turns',
      'POST /api/sessions/:id/turns?wait=1',
      'POST /api/sessions/:id/turns?stream=1 (SSE stream)',
      'POST /api/sessions/:id/interrupt',
      'POST /api/sessions/:id/steer',
      'POST /api/sessions/:id/archive',
    ],
  };
}

// 持久化：单飞 + 合并 + 防抖。
// 旧实现在每个流式 delta 上都 fire-and-forget 全量写盘，导致多个 writeFile 并发竞争
// 同一文件、把状态文件写花（尾部残留垃圾），还把事件循环/磁盘打满。
// 现在：同一时刻只有一次写在进行；写盘期间产生的新改动会被合并进收尾的下一次写；
// 高频路径用 schedulePersist() 防抖，关键端点用 persistState() 立即落盘。
let persistWriting = false;
let persistDirty = false;
let persistDebounceTimer = null;

function buildPersistPayload() {
  return {
    config: {
      codex: config.codex,
      ui: config.ui,
    },
    apps: apps.toJSON(),
    sessions: store.toJSON(),
    push: pushNotifications.toJSON(),
  };
}

async function persistState() {
  if (persistWriting) {
    // 已有写在进行：标脏，让进行中的循环收尾时再写一遍，保证最后状态不丢。
    persistDirty = true;
    return;
  }
  if (persistDebounceTimer) {
    clearTimeout(persistDebounceTimer);
    persistDebounceTimer = null;
  }
  persistWriting = true;
  try {
    do {
      persistDirty = false;
      await saveBridgeState(buildPersistPayload());
    } while (persistDirty);
  } catch (error) {
    publish({ type: 'bridge.persist.error', error: error.message });
  } finally {
    persistWriting = false;
  }
}

// 高频路径（每条 codex 通知/每个 delta）用这个：最多每 ~750ms 落盘一次。
function schedulePersist(delayMs = 750) {
  persistDirty = true;
  if (persistWriting || persistDebounceTimer) {
    return;
  }
  persistDebounceTimer = setTimeout(() => {
    persistDebounceTimer = null;
    persistState();
  }, delayMs);
}

async function serveStatic(req, res, url) {
  const rootPath = shouldServeMobileRoot(req) ? '/m/index.html' : '/index.html';
  const pathname = decodeURIComponent(normalizeStaticPathname(url.pathname, rootPath));
  const target = path.resolve(publicRoot, `.${pathname}`);
  if (!target.startsWith(publicRoot)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    await serveFile(res, target);
  } catch {
    const fallback = path.join(publicRoot, 'index.html');
    const body = await readFile(fallback);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }
}

function shouldServeMobileRoot(req) {
  const host = hostName(req.headers['x-forwarded-host'] || req.headers.host);
  return Boolean(host && !isLoopbackHost(host));
}

function hostName(value) {
  const host = String(value || '').split(',')[0].trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end) : host;
  }
  return host.split(':')[0];
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

async function serveFile(res, target) {
  let info = await stat(target);
  // 目录请求（如 /m/）回退到该目录下的 index.html，避免裸目录 404。
  if (info.isDirectory()) {
    target = path.join(target, 'index.html');
    info = await stat(target); // 缺失则抛出，交由 serveStatic 的兜底处理
  }
  if (!info.isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    // 关键：必须处理读流的 'error'，否则未捕获的 error 事件会让整个进程崩溃（曾因 EMFILE 崩过）。
    stream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy(error);
        settle(resolve);
      } else {
        settle(reject, error); // 头还没发：交给上层兜底成 500
      }
    });
    stream.on('open', () => {
      res.writeHead(200, { 'content-type': contentType(target), 'cache-control': 'no-store' });
      stream.pipe(res);
    });
    stream.on('end', () => settle(resolve));
    res.on('close', () => {
      stream.destroy();
      settle(resolve);
    });
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.map': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.html': 'text/html; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    }[ext] || 'application/octet-stream'
  );
}
