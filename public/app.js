const state = {
  config: null,
  sessions: [],
  selectedSessionId: null,
  selectedSession: null,
  apps: [],
  selectedAppId: null,
  selectedApp: null,
  activeView: 'console',
  events: [],
  models: [],
  eventSource: null,
  debugEventsVisible: new URLSearchParams(window.location.search).get('debug') === '1',
};

const $ = (id) => document.getElementById(id);

const els = {
  serviceDot: $('serviceDot'),
  serviceState: $('serviceState'),
  listenAddress: $('listenAddress'),
  navConsoleBtn: $('navConsoleBtn'),
  navAppsBtn: $('navAppsBtn'),
  consoleView: $('consoleView'),
  appsView: $('appsView'),
  startCodexBtn: $('startCodexBtn'),
  restartCodexBtn: $('restartCodexBtn'),
  authMode: $('authMode'),
  planType: $('planType'),
  refreshAccountBtn: $('refreshAccountBtn'),
  modelSelect: $('modelSelect'),
  effortSelect: $('effortSelect'),
  speedSelect: $('speedSelect'),
  saveConfigBtn: $('saveConfigBtn'),
  cwdInput: $('cwdInput'),
  sandboxSelect: $('sandboxSelect'),
  approvalSelect: $('approvalSelect'),
  ephemeralToggle: $('ephemeralToggle'),
  sessionList: $('sessionList'),
  createSessionBtn: $('createSessionBtn'),
  conversationTitle: $('conversationTitle'),
  conversationMeta: $('conversationMeta'),
  messages: $('messages'),
  composer: $('composer'),
  promptInput: $('promptInput'),
  steerInput: $('steerInput'),
  resumeBtn: $('resumeBtn'),
  interruptBtn: $('interruptBtn'),
  createAppBtn: $('createAppBtn'),
  appsCount: $('appsCount'),
  appList: $('appList'),
  appEditorTitle: $('appEditorTitle'),
  copyAppIdBtn: $('copyAppIdBtn'),
  saveAppBtn: $('saveAppBtn'),
  appEmptyState: $('appEmptyState'),
  appEditor: $('appEditor'),
  appIdValue: $('appIdValue'),
  appWorkspaceValue: $('appWorkspaceValue'),
  appCreatedAtValue: $('appCreatedAtValue'),
  appUpdatedAtValue: $('appUpdatedAtValue'),
  appNameInput: $('appNameInput'),
  appModelSelect: $('appModelSelect'),
  appEffortSelect: $('appEffortSelect'),
  appSpeedSelect: $('appSpeedSelect'),
  appSandboxSelect: $('appSandboxSelect'),
  appApprovalSelect: $('appApprovalSelect'),
  appEphemeralToggle: $('appEphemeralToggle'),
  appEphemeralLabel: $('appEphemeralLabel'),
  ephemeralLabel: $('ephemeralLabel'),
  openJsonBtn: $('openJsonBtn'),
  configDialog: $('configDialog'),
  closeConfigDialogBtn: $('closeConfigDialogBtn'),
  configJson: $('configJson'),
  copyConfigBtn: $('copyConfigBtn'),
  toastStack: $('toastStack'),
  eventsPanel: $('eventsPanel'),
  eventList: $('eventList'),
  clearEventsBtn: $('clearEventsBtn'),
};

boot().catch((error) => pushEvent({ type: 'ui.error', error: error.message }));

async function boot() {
  document.body.classList.toggle('events-hidden', !state.debugEventsVisible);
  bindEvents();
  renderView();
  await refreshAll();
  connectEvents();
  setInterval(refreshLight, state.config?.ui?.refreshMs || 1500);
}

function bindEvents() {
  els.startCodexBtn.addEventListener('click', () =>
    runButtonAction(els.startCodexBtn, 'Starting...', async () => {
      await post('/api/codex/start');
      await refreshAll();
      showToast('Codex app-server 已启动', 'success');
    }),
  );
  els.restartCodexBtn.addEventListener('click', () =>
    runButtonAction(els.restartCodexBtn, 'Restarting...', async () => {
      await post('/api/codex/restart');
      await refreshAll();
      showToast('Codex app-server 已重启', 'success');
    }),
  );
  els.refreshAccountBtn.addEventListener('click', () =>
    runButtonAction(els.refreshAccountBtn, 'Refreshing...', async () => {
      await refreshAccount();
      showToast('账号状态已刷新', 'success');
    }),
  );
  els.saveConfigBtn.addEventListener('click', () =>
    runButtonAction(els.saveConfigBtn, 'Saving...', async () => {
      await saveConfig();
      showToast('默认配置已保存', 'success');
    }),
  );
  els.openJsonBtn.addEventListener('click', () => els.configDialog.showModal());
  els.closeConfigDialogBtn.addEventListener('click', () => els.configDialog.close());
  els.createSessionBtn.addEventListener('click', () =>
    runButtonAction(els.createSessionBtn, 'Creating...', async () => {
      await createSession();
      showToast('新 session 已创建', 'success');
    }),
  );
  els.resumeBtn.addEventListener('click', () =>
    runButtonAction(els.resumeBtn, 'Resuming...', async () => {
      await resumeSelectedSession();
      showToast('session 已恢复', 'success');
    }),
  );
  els.interruptBtn.addEventListener('click', () =>
    runButtonAction(els.interruptBtn, 'Interrupting...', async () => {
      await interruptSelectedSession();
      showToast('已发送中断请求', 'success');
    }),
  );
  els.clearEventsBtn.addEventListener('click', () => {
    state.events = [];
    renderEvents();
    showToast('事件缓存已清空', 'info');
  });
  els.copyConfigBtn.addEventListener('click', () =>
    runButtonAction(els.copyConfigBtn, 'Copying...', async () => {
      await copyText(JSON.stringify(state.config, null, 2));
      pushEvent({ type: 'ui.config.copied' });
      showToast('配置 JSON 已复制到剪贴板', 'success');
    }),
  );
  els.navConsoleBtn.addEventListener('click', () => setView('console'));
  els.navAppsBtn.addEventListener('click', () => setView('apps'));
  els.createAppBtn.addEventListener('click', () =>
    runButtonAction(els.createAppBtn, 'Creating...', async () => {
      await createApp();
      showToast('新 appId 已创建，并复制了当前全局配置', 'success');
    }),
  );
  els.copyAppIdBtn.addEventListener('click', () =>
    runButtonAction(els.copyAppIdBtn, 'Copying...', async () => {
      if (!state.selectedApp) {
        showToast('先选择一个 app', 'warning');
        return;
      }
      await copyText(state.selectedApp.appId);
      showToast('appId 已复制到剪贴板', 'success');
    }),
  );
  els.saveAppBtn.addEventListener('click', () =>
    runButtonAction(els.saveAppBtn, 'Saving...', async () => {
      await saveSelectedApp();
      showToast('APP 默认配置已保存', 'success');
    }),
  );
  els.composer.addEventListener('submit', sendTurn);
}

async function refreshAll() {
  const status = await get('/api/status');
  state.config = status.bridge;
  state.sessions = status.sessions || [];
  state.events = status.events || [];
  applyConfigToControls();
  renderStatus(status);
  renderSessions();
  renderConfig();
  renderEvents();
  await Promise.allSettled([refreshModels(), refreshAccount(), refreshApps()]);
  await refreshLight();
  if (!state.selectedSessionId && state.sessions[0]) {
    await selectSession(state.sessions[0].id);
  } else if (state.selectedSessionId) {
    await selectSession(state.selectedSessionId, { silent: true });
  }
}

async function refreshLight() {
  try {
    const status = await get('/api/status');
    state.config = status.bridge;
    state.sessions = status.sessions || [];
    renderStatus(status);
    renderSessions();
    if (state.selectedSessionId) {
      await selectSession(state.selectedSessionId, { silent: true });
    }
  } catch (error) {
    renderOffline(error);
  }
}

function connectEvents() {
  state.eventSource?.close();
  state.eventSource = new EventSource('/api/events');
  state.eventSource.onmessage = (message) => {
    const event = JSON.parse(message.data);
    pushEvent(event);
    if (event.method || event.type?.startsWith('bridge.turn') || event.type?.startsWith('bridge.session')) {
      refreshLight().catch(() => {});
    }
  };
  state.eventSource.onerror = () => {
    pushEvent({ type: 'ui.sse.error', receivedAt: new Date().toISOString() });
  };
}

async function refreshModels() {
  const result = await get('/api/models');
  state.models = result.data || [];
  populateModelSelect(els.modelSelect, els.modelSelect.value || state.config?.codex?.model || '');
  populateModelSelect(els.appModelSelect, state.selectedApp?.defaults?.model || '');
}

async function refreshAccount() {
  try {
    const result = await get('/api/account');
    const account = result.account;
    els.authMode.textContent = account?.type || 'none';
    els.planType.textContent = account?.planType || '-';
  } catch (error) {
    els.authMode.textContent = 'unknown';
    els.planType.textContent = '-';
    pushEvent({ type: 'ui.account.error', error: error.message });
  }
}

function renderStatus(status) {
  const codex = status.codex || {};
  els.serviceDot.classList.toggle('online', Boolean(codex.started));
  els.serviceDot.classList.toggle('offline', !codex.started);
  els.serviceState.textContent = codex.started ? `connected · pid ${codex.pid}` : 'not started';
  els.listenAddress.textContent = `http://${state.config.server.host}:${state.config.server.port}`;
}

function renderOffline(error) {
  els.serviceDot.classList.remove('online');
  els.serviceDot.classList.add('offline');
  els.serviceState.textContent = 'bridge offline';
  els.listenAddress.textContent = error.message;
}

function applyConfigToControls() {
  const codex = state.config.codex;
  els.cwdInput.value = codex.cwd || '';
  els.modelSelect.value = codex.model || '';
  els.effortSelect.value = codex.effort || 'low';
  els.speedSelect.value = codex.speed || 'balanced';
  els.sandboxSelect.value = codex.sandbox || 'workspace-write';
  els.approvalSelect.value = codex.approvalPolicy || 'never';
  els.ephemeralToggle.checked = Boolean(codex.ephemeral);
}

function renderConfig() {
  const codex = state.config.codex;
  els.ephemeralLabel.textContent = codex.ephemeral ? '开启' : '关闭';
  els.configJson.textContent = JSON.stringify(state.config, null, 2);
}

async function refreshApps() {
  const result = await get('/api/apps');
  state.apps = result.data || [];
  renderAppsList();
  if (!state.selectedAppId && state.apps[0]) {
    await selectApp(state.apps[0].appId);
  } else if (state.selectedAppId) {
    await selectApp(state.selectedAppId, { silent: true });
  } else {
    renderAppEditor();
  }
}

function renderSessions() {
  els.sessionList.innerHTML = '';
  if (!state.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'event-item';
    empty.innerHTML = '<strong>No session</strong><span>点击 New session 创建本地 Codex 会话</span>';
    els.sessionList.appendChild(empty);
    return;
  }

  for (const session of state.sessions) {
    const button = document.createElement('button');
    button.className = `session-item ${session.id === state.selectedSessionId ? 'active' : ''}`;
    button.addEventListener('click', () => selectSession(session.id));
    button.innerHTML = `
      <span class="session-status ${escapeHtml(session.status)}"></span>
      <strong>${escapeHtml(session.name || session.id)}</strong>
      <small>${escapeHtml(session.status)} · ${session.messageCount} messages · ${formatTime(session.updatedAt)}</small>
    `;
    els.sessionList.appendChild(button);
  }
}

function renderAppsList() {
  els.appsCount.textContent = String(state.apps.length);
  els.appList.innerHTML = '';
  if (!state.apps.length) {
    const empty = document.createElement('div');
    empty.className = 'event-item';
    empty.innerHTML = '<strong>No apps</strong><span>点击 Create appId 自动创建一个新的应用身份和默认工作目录。</span>';
    els.appList.appendChild(empty);
    return;
  }

  for (const app of state.apps) {
    const enabled = app.enabled !== false;
    const card = document.createElement('div');
    card.className = `app-item ${app.appId === state.selectedAppId ? 'active' : ''} ${enabled ? '' : 'disabled'}`;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'app-item-main';
    main.addEventListener('click', () => selectApp(app.appId));
    main.innerHTML = `
      <strong>${escapeHtml(app.name)}${enabled ? '' : '<span class="app-flag">已停用</span>'}</strong>
      <small>${escapeHtml(app.appId)}</small>
      <small>${escapeHtml(app.workspaceRoot)}</small>
    `;
    card.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'app-item-actions';

    const toggle = document.createElement('label');
    toggle.className = 'app-toggle';
    toggle.title = enabled ? '取消勾选即停用：停用后该 appId 无法再鉴权访问' : '勾选以重新启用';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabled;
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => toggleApp(app.appId, checkbox.checked));
    const toggleText = document.createElement('span');
    toggleText.textContent = enabled ? '启用' : '停用';
    toggle.append(checkbox, toggleText);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'app-delete';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteApp(app);
    });

    actions.append(toggle, delBtn);
    card.appendChild(actions);
    els.appList.appendChild(card);
  }
}

async function toggleApp(appId, enabled) {
  try {
    await put(`/api/apps/${encodeURIComponent(appId)}`, { enabled });
    await refreshApps();
    showToast(enabled ? '已启用' : '已停用', 'success');
  } catch (error) {
    showError(error);
    await refreshApps();
  }
}

async function deleteApp(app) {
  const ok = window.confirm(
    `确定删除应用 “${app.name}”？\n它的 appId 会立即失效，正在用它接入的客户端会被拒绝。\n工作目录文件不会被删除。`,
  );
  if (!ok) {
    return;
  }
  try {
    await del(`/api/apps/${encodeURIComponent(app.appId)}`);
    if (state.selectedAppId === app.appId) {
      state.selectedAppId = null;
      state.selectedApp = null;
    }
    await refreshApps();
    showToast('已删除应用', 'success');
  } catch (error) {
    showError(error);
  }
}

async function selectApp(appId, { silent = false } = {}) {
  try {
    const result = await get(`/api/apps/${encodeURIComponent(appId)}`);
    state.selectedAppId = appId;
    state.selectedApp = result.app;
    renderAppsList();
    renderAppEditor();
  } catch (error) {
    if (!silent) showError(error);
  }
}

async function selectSession(id, { silent = false } = {}) {
  try {
    const result = await get(`/api/sessions/${encodeURIComponent(id)}`);
    state.selectedSessionId = id;
    state.selectedSession = result.session;
    renderSessions();
    renderConversation();
  } catch (error) {
    if (!silent) showError(error);
  }
}

function renderConversation() {
  const session = state.selectedSession;
  if (!session) {
    els.conversationTitle.textContent = '未选择 session';
    els.conversationMeta.textContent = '';
    els.messages.innerHTML = '';
    return;
  }

  els.conversationTitle.textContent = session.name || session.id;
  els.conversationMeta.textContent = `${session.threadId} · ${session.cwd} · ${session.status}`;
  els.messages.innerHTML = '';

  for (const message of session.messages || []) {
    const item = document.createElement('div');
    item.className = `message ${message.role} ${message.status === 'streaming' ? 'streaming' : ''}`;
    item.textContent = message.text || (message.role === 'assistant' ? '...' : '');
    els.messages.appendChild(item);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderAppEditor() {
  const app = state.selectedApp;
  const hasApp = Boolean(app);
  els.appEmptyState.hidden = hasApp;
  els.appEditor.hidden = !hasApp;
  els.copyAppIdBtn.disabled = !hasApp;
  els.saveAppBtn.disabled = !hasApp;

  if (!app) {
    els.appEditorTitle.textContent = '未选择 app';
    return;
  }

  els.appEditorTitle.textContent = app.name;
  els.appIdValue.textContent = app.appId;
  els.appWorkspaceValue.textContent = app.workspaceRoot;
  els.appCreatedAtValue.textContent = formatDateTime(app.createdAt);
  els.appUpdatedAtValue.textContent = formatDateTime(app.updatedAt);
  els.appNameInput.value = app.name;
  populateModelSelect(els.appModelSelect, app.defaults.model || '');
  els.appEffortSelect.value = app.defaults.effort || 'low';
  els.appSpeedSelect.value = app.defaults.speed || 'balanced';
  els.appSandboxSelect.value = app.defaults.sandbox || 'workspace-write';
  els.appApprovalSelect.value = app.defaults.approvalPolicy || 'never';
  els.appEphemeralToggle.checked = Boolean(app.defaults.ephemeral);
  els.appEphemeralLabel.textContent = app.defaults.ephemeral ? '开启' : '关闭';
}

function renderEvents() {
  if (!state.debugEventsVisible) {
    return;
  }
  els.eventList.innerHTML = '';
  for (const event of state.events.slice(-120).reverse()) {
    const item = document.createElement('div');
    item.className = 'event-item';
    const name = event.type || event.method || event.event?.method || 'event';
    const detail = event.error || event.text || event.params?.turnId || event.params?.threadId || event.sessionId || '';
    item.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(formatTime(event.receivedAt || event.event?.receivedAt))} ${escapeHtml(String(detail).slice(0, 120))}</span>`;
    els.eventList.appendChild(item);
  }
}

async function saveConfig() {
  const patch = {
    codex: {
      cwd: els.cwdInput.value.trim(),
      model: els.modelSelect.value || null,
      effort: els.effortSelect.value,
      speed: els.speedSelect.value,
      sandbox: els.sandboxSelect.value,
      approvalPolicy: els.approvalSelect.value,
      ephemeral: els.ephemeralToggle.checked,
    },
  };
  state.config = await put('/api/config', patch);
  renderConfig();
  pushEvent({ type: 'ui.config.saved' });
}

async function createSession() {
  await saveConfig();
  const result = await post('/api/sessions', {
    name: `Session ${new Date().toLocaleTimeString()}`,
    model: els.modelSelect.value || null,
    effort: els.effortSelect.value,
    speed: els.speedSelect.value,
    sandbox: els.sandboxSelect.value,
    approvalPolicy: els.approvalSelect.value,
    ephemeral: els.ephemeralToggle.checked,
  });
  state.selectedSessionId = result.session.id;
  await refreshAll();
  await selectSession(result.session.id);
}

async function createApp() {
  const result = await post('/api/apps', {});
  state.selectedAppId = result.app.appId;
  await refreshApps();
  await selectApp(result.app.appId);
  setView('apps');
}

async function saveSelectedApp() {
  if (!state.selectedApp) {
    showToast('先选择一个 app', 'warning');
    return;
  }

  const result = await put(`/api/apps/${encodeURIComponent(state.selectedApp.appId)}`, {
    name: els.appNameInput.value.trim(),
    defaults: {
      model: els.appModelSelect.value || null,
      effort: els.appEffortSelect.value,
      speed: els.appSpeedSelect.value,
      sandbox: els.appSandboxSelect.value,
      approvalPolicy: els.appApprovalSelect.value,
      ephemeral: els.appEphemeralToggle.checked,
    },
  });
  state.selectedApp = result.app;
  await refreshApps();
  renderAppEditor();
}

async function resumeSelectedSession() {
  if (!state.selectedSessionId) {
    showToast('先选择一个 session', 'warning');
    return;
  }
  await post(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}/resume`, {});
  await selectSession(state.selectedSessionId);
}

async function interruptSelectedSession() {
  if (!state.selectedSessionId) {
    showToast('先选择一个 session', 'warning');
    return;
  }
  await post(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}/interrupt`, {});
  await refreshLight();
}

async function sendTurn(event) {
  event.preventDefault();
  const submitButton = els.composer.querySelector('button[type="submit"]');
  if (!state.selectedSessionId) {
    await createSession();
  }
  const text = els.promptInput.value.trim();
  const steerText = els.steerInput.value.trim();
  if (!text && !steerText) return;

  if (steerText && state.selectedSession?.activeTurnId) {
    await runButtonAction(submitButton, 'Steering...', async () => {
      await post(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}/steer`, { text: steerText });
      els.steerInput.value = '';
      showToast('已追加 steer 指令', 'success');
    });
    return;
  }

  await runButtonAction(submitButton, 'Sending...', async () => {
    await post(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}/turns`, {
      text,
      model: els.modelSelect.value || null,
      effort: els.effortSelect.value,
    });
    els.promptInput.value = '';
    await refreshLight();
    showToast('新 turn 已发送', 'success');
  });
}

function pushEvent(event) {
  state.events.push({ ...event, receivedAt: event.receivedAt || new Date().toISOString() });
  if (state.events.length > 300) state.events.shift();
  if (state.debugEventsVisible) {
    renderEvents();
  }
}

async function get(path) {
  const res = await fetch(path);
  return parseResponse(res);
}

async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseResponse(res);
}

async function put(path, body = {}) {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseResponse(res);
}

async function del(path) {
  const res = await fetch(path, { method: 'DELETE' });
  return parseResponse(res);
}

async function parseResponse(res) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error?.message || `${res.status} ${res.statusText}`);
  }
  return json;
}

function showError(error) {
  pushEvent({ type: 'ui.error', error: error.message });
  showToast(error.message || '操作失败', 'error');
}

function setView(view) {
  state.activeView = view;
  renderView();
}

function renderView() {
  const isConsole = state.activeView === 'console';
  els.consoleView.hidden = !isConsole;
  els.appsView.hidden = isConsole;
  els.navConsoleBtn.classList.toggle('is-active', isConsole);
  els.navAppsBtn.classList.toggle('is-active', !isConsole);
}

function populateModelSelect(select, value = '') {
  if (!select) return;
  select.innerHTML = '<option value="">Auto / Codex default</option>';
  for (const item of state.models) {
    const option = document.createElement('option');
    option.value = item.id || item.model;
    option.textContent = `${item.displayName || item.id || item.model}${item.isDefault ? ' · default' : ''}`;
    select.appendChild(option);
  }
  select.value = value || '';
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fallback below handles browsers or embedded shells that deny clipboard permission.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('复制失败：浏览器拒绝写入剪贴板，可先点 View JSON 再手动复制。');
  }
}

async function runButtonAction(button, busyText, action) {
  const original = button.textContent;
  button.disabled = true;
  button.classList.add('is-busy');
  if (busyText) {
    button.textContent = busyText;
  }
  try {
    return await action();
  } catch (error) {
    showError(error);
    throw error;
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
    button.textContent = original;
  }
}

function showToast(message, tone = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = String(message ?? '');
  els.toastStack.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 220);
  }, 2200);
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return date.toLocaleTimeString();
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '-';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
