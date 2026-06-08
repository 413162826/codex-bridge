import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { evaluateApiAccess, publicSecurityConfig } from './accessControl.js';
import { AppRegistry, resolveAppEffectiveCodexConfig } from './appRegistry.js';
import { CodexAppServerClient } from './codexAppServerClient.js';
import { createCodexHistory } from './codexHistory.js';
import { createRuntimeConfig, mergeConfig } from './config.js';
import { createImageUpload, extractWorkspaceImagePaths, isPathInside, resolveUploadAppId } from './fileGateway.js';
import { readJsonBody, sendError, sendJson, sendText } from './json.js';
import { createOpenApiSpec } from './openapi.js';
import { SessionStore, classifyConnectionNotice } from './sessionStore.js';
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
const history = createCodexHistory();
const bus = new EventEmitter();
bus.setMaxListeners(200);

let codex = createClient();
wireClient(codex);

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => sendError(res, error));
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`Codex Bridge listening on http://${config.server.host}:${config.server.port}`);
});

function createClient() {
  return new CodexAppServerClient({ cwd: config.codex.cwd });
}

function wireClient(client) {
  client.on('notification', (event) => {
    store.applyNotification(event);
    schedulePersist();
    publish({ type: 'codex.notification', ...event });
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

async function createSession(req, res) {
  await codex.ensureStarted();
  const body = await readJsonBody(req);
  if (req.access?.scope === 'app') {
    if (body.appId && body.appId !== req.access.appId) {
      const error = new Error('当前 appId 不能为其他 APP 创建 session');
      error.statusCode = 403;
      throw error;
    }
    body.appId = req.access.appId;
  }
  const app = body.appId ? apps.require(body.appId) : null;
  const request = normalizeSessionRequest(body, app);
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
  const meta = await history.getThreadMeta(threadId);
  if (!meta) {
    const error = new Error(`未找到历史对话：${threadId}`);
    error.statusCode = 404;
    throw error;
  }
  const existing = store.get(threadId);
  const result = await codex.request('thread/resume', {
    threadId,
    cwd: meta.cwd,
    approvalPolicy: config.codex.approvalPolicy,
    sandbox: config.codex.sandbox,
    model: config.codex.model,
    persistExtendedHistory: true,
    excludeTurns: false,
  });
  const claimedAppId = req.access?.scope === 'app' ? req.access.appId : existing?.appId ?? null;
  const request = {
    cwd: meta.cwd,
    name: existing?.name || meta.projectName || threadId,
    appId: claimedAppId,
  };
  const session = store.upsertResumedSession({ thread: result.thread, request, config });
  // upsert 不改既有会话的 cwd/appId，这里显式落实：手机端 appId 认领该会话，cwd 用历史真实目录。
  session.cwd = meta.cwd;
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
    const result = await codex.request('thread/resume', {
      threadId: session.threadId,
      cwd: session.cwd,
      approvalPolicy: body.approvalPolicy || session.approvalPolicy,
      sandbox: body.sandbox || session.sandbox,
      model: body.model ?? session.model,
      persistExtendedHistory: true,
      excludeTurns: false,
    });
    const resumed = store.upsertResumedSession({ thread: result.thread, request: body, config });
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
  await settlePrewarm(session);
  const wait = url.searchParams.get('wait') === '1';
  const completionPromise = wait ? waitForTurnCompleted(session.threadId) : null;
  const result = await codex.request('turn/start', {
    threadId: session.threadId,
    input,
    approvalPolicy: body.approvalPolicy,
    sandboxPolicy: body.sandboxPolicy,
    model: body.model ?? session.model,
    effort: body.effort ?? session.effort,
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
    if (body.appId && body.appId !== req.access.appId) {
      const error = new Error('当前 appId 不能为其他 APP 创建 session');
      error.statusCode = 403;
      throw error;
    }
    body.appId = req.access.appId;
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
  const appId = req.access?.scope === 'app' ? req.access.appId : session.appId || null;
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
    finished = true;
    cleanup();
    scanImages(assistantText, turn?.id ?? activeTurnId);
    Promise.allSettled(imageScans).then(() => {
      writeTypedSse(res, 'done', {
        turnId: turn?.id ?? activeTurnId,
        status: turn?.status === 'interrupted' ? 'interrupted' : 'completed',
        finalText: assistantText,
      });
      res.end();
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
      const delta = params.delta ?? '';
      assistantText += delta;
      writeTypedSse(res, 'delta', { turnId: params.turnId ?? activeTurnId, delta, seq: seq++ });
    } else if (event.method === 'item/completed' && params.item?.type === 'agentMessage') {
      scanImages(params.item.text || '', params.turnId ?? activeTurnId);
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
    result = await codex.request('turn/start', {
      threadId: session.threadId,
      input,
      approvalPolicy: body.approvalPolicy,
      sandboxPolicy: body.sandboxPolicy,
      model: body.model ?? session.model,
      effort: body.effort ?? session.effort,
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

// 用请求自身的协议+host 拼绝对地址：经隧道进来是 https://bridge.kevinsu.xyz，本机是 http://127.0.0.1:4555。
// 这样发给非局域网 App 的图片 url 可直接取用，不用客户端自己拼 base。
function requestBaseUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto ? String(forwardedProto).split(',')[0].trim() : 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${config.server.host}:${config.server.port}`;
  return `${proto}://${String(host).split(',')[0].trim()}`;
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
  if (req.access?.scope !== 'app') {
    return store.list();
  }
  return store.list().filter((session) => session.appId === req.access.appId);
}

function assertSessionAccess(req, session) {
  if (req.access?.scope !== 'app') {
    return;
  }
  if (session.appId === req.access.appId) {
    return;
  }
  const error = new Error('当前 appId 无权访问该 session');
  error.statusCode = 403;
  throw error;
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
      'GET /api/sessions',
      'POST /api/sessions',
      'GET /api/projects',
      'GET /api/projects/:id/threads',
      'GET /api/threads/:id',
      'POST /api/threads/:id/resume',
      'POST /api/chat (SSE stream)',
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
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
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

async function serveFile(res, target) {
  const info = await stat(target);
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
