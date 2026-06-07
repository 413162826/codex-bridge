const baseUrl = process.env.CODEX_BRIDGE_URL || 'http://127.0.0.1:4555';
const requestedAppId = process.env.CODEX_BRIDGE_APP_ID || '';
const onePixelPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lW5e9QAAAABJRU5ErkJggg==';

async function main() {
  const health = await request('/api/health');
  console.log('health:', health.ok, health.codex.started ? 'codex-started' : 'codex-idle');

  await request('/api/codex/start', { method: 'POST' });
  const app = requestedAppId ? await readApp(requestedAppId) : await createApp();
  console.log('app:', app.appId);

  const appHeaders = appAuthHeaders(app.appId);
  const upload = await request('/api/uploads/images', {
    method: 'POST',
    headers: appHeaders,
    body: {
      fileName: 'android-smoke.png',
      mimeType: 'image/png',
      base64: onePixelPngBase64,
    },
  });
  assertEqual(upload.upload.input.type, 'localImage', 'upload returns localImage input');
  assert(upload.upload.path.startsWith(app.workspaceRoot), 'upload is inside app workspace');
  console.log('upload:', upload.upload.fileName, upload.upload.size);

  const sessionResult = await request('/api/sessions', {
    method: 'POST',
    headers: appHeaders,
    body: {
      name: 'Android app smoke',
      appId: app.appId,
      ephemeral: false,
      persistExtendedHistory: true,
      effort: 'low',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    },
  });
  const sessionId = sessionResult.session.id;
  console.log('session:', sessionId);

  const fileRes = await fetchJsonless(
    `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(upload.upload.path)}`,
    { headers: appHeaders },
  );
  assertEqual(fileRes.status, 200, 'session file route status');
  assertEqual(fileRes.bytes, 70, 'session file route bytes');
  console.log('file:', fileRes.status, fileRes.bytes);

  const firstTurn = await sendWait(sessionId, appHeaders, '只回复 ANDROID-BRIDGE-SMOKE');
  assertLastAssistant(firstTurn.session, 'ANDROID-BRIDGE-SMOKE');

  const secondTurn = await sendWait(sessionId, appHeaders, '继续使用同一个会话，只回复 ANDROID-BRIDGE-SMOKE-2');
  assertLastAssistant(secondTurn.session, 'ANDROID-BRIDGE-SMOKE-2');
  assertEqual(secondTurn.session.messages.length, 4, 'continuous session message count');

  const sessions = await request('/api/sessions', { headers: appHeaders });
  const listed = sessions.data.find((item) => item.id === sessionId);
  assert(listed, 'created session is listed');
  assertEqual(listed.messageCount, 4, 'listed session message count');
  console.log('listed:', listed.id, listed.messageCount);
}

async function readApp(appId) {
  const result = await request(`/api/apps/${encodeURIComponent(appId)}`, {
    headers: appAuthHeaders(appId),
  });
  return result.app;
}

async function createApp() {
  const result = await request('/api/apps', {
    method: 'POST',
    body: { name: 'android-smoke' },
  });
  return result.app;
}

async function sendWait(sessionId, headers, text) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/turns?wait=1`, {
    method: 'POST',
    headers,
    body: { text, effort: 'low' },
  });
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error?.message || `${res.status} ${res.statusText}`);
  }
  return json;
}

async function fetchJsonless(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: options.headers || {},
  });
  const buffer = await res.arrayBuffer();
  return { status: res.status, bytes: buffer.byteLength };
}

function appAuthHeaders(appId) {
  return {
    authorization: `Bearer ${appId}`,
    'x-codex-app-id': appId,
  };
}

function assertLastAssistant(session, expected) {
  const assistant = session.messages.filter((item) => item.role === 'assistant').at(-1);
  assertEqual(String(assistant?.text || '').trim(), expected, `assistant replies ${expected}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(value, label) {
  if (!value) {
    throw new Error(label);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
