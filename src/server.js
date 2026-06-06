import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { AppRegistry, resolveAppEffectiveCodexConfig } from './appRegistry.js';
import { CodexAppServerClient } from './codexAppServerClient.js';
import { createRuntimeConfig, mergeConfig } from './config.js';
import { readJsonBody, sendError, sendJson, sendText } from './json.js';
import { createOpenApiSpec } from './openapi.js';
import { SessionStore } from './sessionStore.js';
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
const store = new SessionStore();
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
    res.setHeader('access-control-allow-headers', 'content-type,authorization');
  }
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/health') {
    sendJson(res, 200, { ok: true, bridge: publicConfig(), codex: codex.getStatus() });
    return;
  }

  if (route === 'GET /api/status') {
    sendJson(res, 200, {
      bridge: publicConfig(),
      codex: codex.getStatus(),
      sessions: store.list().map(summarySession),
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
    sendJson(res, 200, { data: store.list().map(summarySession) });
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

  if (route === 'POST /api/sessions') {
    await createSession(req, res);
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
  publish({ type: 'bridge.session.created', session: summarySession(session), receivedAt: new Date().toISOString() });
  sendJson(res, 201, { session });
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

  const error = new Error(`未知 app API：${req.method} /api/apps/${appId}`);
  error.statusCode = 404;
  throw error;
}

async function handleSessionRoute(req, res, url, sessionId, action) {
  if (req.method === 'GET' && !action) {
    sendJson(res, 200, { session: store.require(sessionId) });
    return;
  }

  if (req.method === 'POST' && action === 'resume') {
    await codex.ensureStarted();
    const body = await readJsonBody(req);
    const session = store.require(sessionId);
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
    sendJson(res, 200, { session: resumed });
    return;
  }

  if (req.method === 'GET' && action === 'events') {
    openSse(res, sessionId);
    return;
  }

  if (req.method === 'POST' && action === 'turns') {
    await startTurn(req, res, url, sessionId);
    return;
  }

  if (req.method === 'POST' && action === 'interrupt') {
    const session = store.require(sessionId);
    if (!session.activeTurnId) {
      sendJson(res, 200, { ok: true, skipped: true, reason: 'session 没有正在运行的 turn' });
      return;
    }
    const result = await codex.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === 'POST' && action === 'steer') {
    const session = store.require(sessionId);
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
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === 'POST' && action === 'archive') {
    const session = store.require(sessionId);
    const result = await codex.request('thread/archive', { threadId: session.threadId });
    session.status = 'archived';
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
  const body = await readJsonBody(req);
  const input = normalizeInput(body);
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
    api: apiDocumentation(),
  };
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
      'GET /api/server-requests',
      'POST /api/server-requests/:id/respond',
      'GET /api/sessions',
      'POST /api/sessions',
      'GET /api/sessions/:id',
      'POST /api/sessions/:id/resume',
      'GET /api/sessions/:id/events',
      'POST /api/sessions/:id/turns',
      'POST /api/sessions/:id/turns?wait=1',
      'POST /api/sessions/:id/interrupt',
      'POST /api/sessions/:id/steer',
      'POST /api/sessions/:id/archive',
    ],
  };
}

async function persistState() {
  await saveBridgeState({
    config: {
      codex: config.codex,
      ui: config.ui,
    },
    apps: apps.toJSON(),
  });
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
  res.writeHead(200, {
    'content-type': contentType(target),
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(res);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.map': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.html': 'text/html; charset=utf-8',
      '.png': 'image/png',
    }[ext] || 'application/octet-stream'
  );
}
