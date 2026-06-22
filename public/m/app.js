// 手机端 Code Chat：只依赖 /api/mobile/* 契约，避免把管理台旧接口组合泄漏到前端。

const CONFIG_KEY = 'codexChatMobile.config';
const LAST_SESSION_KEY = 'codexChatMobile.lastSessionId';
const DESKTOP_QUERY = '(min-width: 900px)';

const els = {
  messages: document.getElementById('messages'),
  welcome: document.getElementById('welcome'),
  input: document.getElementById('input'),
  composer: document.getElementById('composer'),
  sendBtn: document.getElementById('sendBtn'),
  moreBtn: document.getElementById('moreBtn'),
  composerPanel: document.getElementById('composerPanel'),
  imageBtn: document.getElementById('imageBtn'),
  attachImageBtn: document.getElementById('attachImageBtn'),
  attachBtn: document.getElementById('attachBtn'),
  fileInput: document.getElementById('fileInput'),
  attachList: document.getElementById('attachList'),
  hint: document.getElementById('hint'),
  title: document.getElementById('title'),
  menuBtn: document.getElementById('menuBtn'),
  newBtn: document.getElementById('newBtn'),
  drawer: document.getElementById('drawer'),
  backdrop: document.getElementById('backdrop'),
  closeDrawer: document.getElementById('closeDrawer'),
  drawerBack: document.getElementById('drawerBack'),
  drawerTitle: document.getElementById('drawerTitle'),
  drawerNew: document.getElementById('drawerNew'),
  drawerList: document.getElementById('drawerList'),
  pushBtn: document.getElementById('pushBtn'),
  pushLabel: document.getElementById('pushLabel'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDialog: document.getElementById('settingsDialog'),
  baseUrlInput: document.getElementById('baseUrlInput'),
  appIdInput: document.getElementById('appIdInput'),
  settingsSave: document.getElementById('settingsSave'),
  settingsCancel: document.getElementById('settingsCancel'),
  suggest: document.getElementById('suggest'),
  toast: document.getElementById('toast'),
};

const config = loadConfig();
const state = {
  booted: false,
  drawerView: 'projects',
  projects: [],
  sessions: [],
  prompts: [],
  push: null,
  pushStatus: 'idle',
  pushIssue: '',
  launchSessionId: '',
  currentProject: null,
  currentSession: null,
  pendingProjectId: null,
  messages: [],
  attachments: [],
  imageMode: false,
  streaming: false,
};

const messageEls = new Map();
let msgSeq = 0;
let scrollFrame = 0;
let audioContext = null;
let notifierUnlocked = false;

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
  } catch {
    return {};
  }
}

function saveConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function applyUrlConfig() {
  const params = new URLSearchParams(location.search);
  const urlAppId = (params.get('appId') || params.get('accessKey') || '').trim();
  const rawBase = (params.get('baseUrl') || params.get('bridge') || '').trim();
  const launchSessionId = (params.get('sessionId') || params.get('threadId') || '').trim();
  let changed = false;
  if (launchSessionId) {
    state.launchSessionId = launchSessionId;
  }
  if (urlAppId && config.appId !== urlAppId) {
    config.appId = urlAppId;
    changed = true;
  }
  if (rawBase) {
    const normalized = normalizeBridgeBaseUrl(rawBase);
    if (config.baseUrl !== normalized) {
      config.baseUrl = normalized;
      changed = true;
    }
  }
  if (changed) saveConfig();

  if ((urlAppId || rawBase || launchSessionId) && window.history?.replaceState) {
    params.delete('appId');
    params.delete('accessKey');
    params.delete('baseUrl');
    params.delete('bridge');
    params.delete('sessionId');
    params.delete('threadId');
    const query = params.toString();
    window.history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }
}

function baseUrl() {
  return normalizeBridgeBaseUrl(config.baseUrl || location.origin);
}

function appId() {
  return (config.appId || '').trim();
}

function authHeaders() {
  return appId() ? { Authorization: `Bearer ${appId()}` } : {};
}

function normalizeBridgeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return location.origin;
  try {
    return new URL(raw, location.origin).origin;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

async function api(method, path, body) {
  const res = await fetch(baseUrl() + path, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...authHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  const json = text ? safeJson(text) : {};
  if (!res.ok) {
    throw new Error(json?.error?.message || `${res.status} ${res.statusText}`);
  }
  if (!json) {
    throw new Error('Bridge 地址不是站点根地址，请填 https://example.com 这种形式');
  }
  return json;
}

async function streamRequest(path, body, onEvent) {
  const res = await fetch(baseUrl() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    const json = safeJson(text);
    throw new Error(json?.error?.message || `${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf('\n\n');
    while (sep >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      handleSseFrame(frame, onEvent);
      sep = buffer.indexOf('\n\n');
    }
  }
}

function handleSseFrame(frame, onEvent) {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;
  const payload = safeJson(data);
  if (payload) onEvent(event, payload);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function bootstrap() {
  const data = await api('GET', '/api/mobile/bootstrap');
  state.booted = true;
  state.projects = sortProjectsByActivity(data.projects || []);
  state.prompts = data.prompts || [];
  state.push = data.push || null;
  renderPrompts();
  const launchSessionId = state.launchSessionId;
  state.launchSessionId = '';
  if (launchSessionId) {
    try {
      await openSession({ id: launchSessionId }, { quiet: true });
    } catch {
      if (data.defaultSession) openSessionObject(data.defaultSession);
      else newSession({ focus: false });
    }
  } else if (data.defaultSession) {
    openSessionObject(data.defaultSession);
  } else {
    newSession({ focus: false });
  }
  syncPushButton();
  refreshPushRegistrationStatus().catch(() => {});
  renderDrawer();
}

function openSessionObject(session) {
  state.currentSession = session;
  state.pendingProjectId = null;
  clearMessages();
  setTitle(session.title || session.projectName || 'Codex Chat');
  hideWelcome();
  for (const message of session.messages || []) {
    if (!String(message.text || '').trim() && message.role === 'assistant') continue;
    addMessage({ role: message.role, text: message.text || '', status: message.status || 'done' });
  }
  if (!state.messages.length) showWelcome();
  rememberSession(session.id);
  scrollToBottom();
}

async function openSession(sessionLike, { quiet = false } = {}) {
  if (state.streaming) {
    if (!quiet) toast('正在回复中，稍候再切换');
    return;
  }
  try {
    const source = sessionLike.source ? `?source=${encodeURIComponent(sessionLike.source)}` : '';
    const res = await api('GET', `/api/mobile/sessions/${encodeURIComponent(sessionLike.id)}${source}`);
    openSessionObject(res.session);
    closeDrawer();
  } catch (error) {
    if (!quiet) toast(error.message);
  }
}

async function openProject(project) {
  state.currentProject = project;
  state.drawerView = 'sessions';
  state.sessions = [];
  els.drawerBack.hidden = false;
  els.drawerTitle.textContent = project.name;
  els.drawerList.innerHTML = '<div class="session-empty">加载中...</div>';
  try {
    const res = await api('GET', `/api/mobile/projects/${encodeURIComponent(project.id)}/sessions`);
    state.sessions = res.sessions || [];
  } catch (error) {
    state.sessions = [];
    toast('历史会话读取失败：' + error.message);
  }
  renderDrawer();
}

function backToProjects() {
  state.drawerView = 'projects';
  state.currentProject = null;
  renderDrawer();
}

function newSession({ focus = true } = {}) {
  if (state.streaming) {
    toast('正在回复中，稍候再新建');
    return;
  }
  state.currentSession = null;
  state.pendingProjectId = state.currentProject?.id || null;
  clearMessages();
  clearAttachments();
  showWelcome();
  setTitle(state.currentProject ? `新对话 · ${state.currentProject.name}` : 'Codex Chat');
  closeDrawer();
  if (focus) els.input.focus();
}

function renderDrawer() {
  const list = els.drawerList;
  list.innerHTML = '';
  if (state.drawerView === 'sessions' && state.currentProject) {
    els.drawerBack.hidden = false;
    els.drawerTitle.textContent = state.currentProject.name;

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'thread-new';
    newBtn.textContent = '＋ 在此项目新建对话';
    newBtn.addEventListener('click', () => newSession());
    list.appendChild(newBtn);

    if (!state.sessions.length) {
      list.appendChild(emptyHint('该项目还没有历史会话。'));
      return;
    }
    for (const session of state.sessions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `session-item thread-item ${session.id === state.currentSession?.id ? 'active' : ''}`;
      const name = document.createElement('strong');
      name.textContent = session.title || '(无标题对话)';
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      const time = document.createElement('span');
      time.className = 'item-time';
      time.textContent = session.updatedAt || session.startedAt ? `最近 ${formatTime(session.updatedAt || session.startedAt)}` : '暂无时间';
      meta.appendChild(time);
      const preview = document.createElement('span');
      preview.className = 'item-preview';
      preview.textContent = session.preview && session.preview !== session.title ? session.preview : '';
      btn.append(name, meta);
      if (preview.textContent) btn.appendChild(preview);
      btn.addEventListener('click', () => openSession(session));
      list.appendChild(btn);
    }
    return;
  }

  els.drawerBack.hidden = true;
  els.drawerTitle.textContent = '项目';
  if (!state.projects.length) {
    list.appendChild(emptyHint(state.booted ? '没有读到项目历史。' : '正在加载项目...'));
    return;
  }
  for (const project of state.projects) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `session-item project-item ${project.conversationCount ? '' : 'muted'}`;
    const row = document.createElement('div');
    row.className = 'project-row';
    const name = document.createElement('strong');
    name.textContent = project.name;
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '›';
    row.append(name, chev);
    const meta = document.createElement('div');
    meta.className = 'item-meta project-meta';
    const time = document.createElement('span');
    time.className = 'item-time';
    time.textContent = project.lastActivity ? `最近 ${formatTime(project.lastActivity)}` : '暂无对话';
    const count = document.createElement('span');
    count.className = 'item-count';
    count.textContent = `${project.conversationCount || 0} 段`;
    meta.append(time, count);
    btn.append(row, meta);
    btn.addEventListener('click', () => openProject(project));
    list.appendChild(btn);
  }
}

function renderPrompts() {
  els.suggest.innerHTML = '';
  for (const prompt of state.prompts.slice(0, 3)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = prompt.text;
    btn.addEventListener('click', () => send(prompt.text, { mode: prompt.mode || 'text' }));
    els.suggest.appendChild(btn);
  }
}

async function send(rawText, { mode = state.imageMode ? 'image' : 'text' } = {}) {
  const text = String(rawText || '').trim();
  if ((!text && !state.attachments.length) || state.streaming) return;

  unlockCompletionNotifier();
  hideWelcome();
  state.streaming = true;
  setComposerEnabled(false);
  els.hint.textContent = 'Codex 正在回复...';
  let completed = false;

  const files = [...state.attachments];
  const user = addMessage({
    role: 'user',
    text: text || '（附件）',
    status: 'done',
    files: files.map((file) => ({ name: file.name, kind: file.type?.startsWith('image/') ? 'image' : 'file' })),
  });
  const assistant = addMessage({ role: 'assistant', text: '', images: [], status: 'pending' });
  scrollToBottom();

  try {
    const attachments = await readAttachments(files);
    clearAttachments();
    await streamRequest(
      '/api/mobile/chat',
      {
        sessionId: state.currentSession?.id || localStorage.getItem(LAST_SESSION_KEY) || null,
        projectId: state.currentSession ? null : state.pendingProjectId,
        text,
        mode,
        attachments,
      },
      (event, data) => {
        if (event === 'session') {
          state.currentSession = {
            ...(state.currentSession || {}),
            id: data.sessionId,
            threadId: data.threadId,
            cwd: data.cwd,
            title: state.currentSession?.title || projectNameFromPath(data.cwd) || 'Codex Chat',
          };
          state.pendingProjectId = null;
          rememberSession(data.sessionId);
          setTitle(state.currentSession.title);
        } else if (event === 'delta') {
          assistant.text += data.delta || '';
          assistant.status = 'streaming';
          renderMessage(assistant);
          scrollIfNear();
        } else if (event === 'image') {
          const src = data.dataUrl || data.url;
          if (src && !assistant.images.includes(src)) {
            assistant.images.push(src);
            renderMessage(assistant);
            scrollIfNear();
          }
        } else if (event === 'notice') {
          els.hint.textContent = data.message || '连接波动，正在继续...';
        } else if (event === 'error') {
          assistant.error = data.message || 'Codex 调用失败';
          renderMessage(assistant);
        } else if (event === 'done') {
          if (data.finalText && !assistant.text) {
            assistant.text = data.finalText;
          }
          completed = !data.status || data.status === 'completed';
        }
      },
    );
  } catch (error) {
    assistant.error = assistant.text ? null : error.message;
    if (assistant.error) renderMessage(assistant);
    toast(error.message);
  } finally {
    void user;
    assistant.status = 'done';
    renderMessage(assistant);
    state.streaming = false;
    state.imageMode = false;
    setImageMode(false);
    setComposerEnabled(true);
    els.hint.textContent = '';
    if (completed && !assistant.error) {
      markCurrentActivity(new Date().toISOString(), text);
      notifyTurnComplete();
    }
    scrollToBottom();
  }
}

function addMessage(msg) {
  msg.id = `m${++msgSeq}`;
  msg.images ||= [];
  msg.files ||= [];
  state.messages.push(msg);
  renderMessage(msg);
  return msg;
}

function renderMessage(msg) {
  let entry = messageEls.get(msg.id);
  if (!entry) {
    const root = document.createElement('div');
    root.className = `msg ${msg.role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const text = document.createElement('span');
    text.className = 'bubble-text';
    const files = document.createElement('div');
    files.className = 'bubble-files';
    const images = document.createElement('div');
    images.className = 'bubble-images';
    bubble.append(text, files, images);
    root.appendChild(bubble);
    els.messages.appendChild(root);
    entry = { root, bubble, text, files, images };
    messageEls.set(msg.id, entry);
  }
  entry.text.textContent = msg.error || msg.text || '';
  entry.text.style.color = msg.error ? 'var(--danger)' : '';
  entry.bubble.classList.toggle('pending', msg.role === 'assistant' && msg.status === 'pending' && !msg.text && !msg.error);

  entry.files.innerHTML = '';
  for (const file of msg.files || []) {
    const pill = document.createElement('span');
    pill.textContent = `${file.kind === 'image' ? '图片' : '文件'} · ${file.name}`;
    entry.files.appendChild(pill);
  }

  if (entry.images.childElementCount !== msg.images.length) {
    entry.images.innerHTML = '';
    for (const src of msg.images) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '生成的图片';
      img.src = src;
      entry.images.appendChild(img);
    }
  }
}

function clearMessages() {
  for (const entry of messageEls.values()) entry.root.remove();
  messageEls.clear();
  state.messages = [];
}

function hideWelcome() {
  els.welcome.hidden = true;
}

function showWelcome() {
  els.welcome.hidden = false;
}

function setComposerEnabled(enabled) {
  els.input.disabled = !enabled;
  els.sendBtn.disabled = !enabled;
  els.moreBtn.disabled = !enabled;
  els.imageBtn.disabled = !enabled;
  els.attachImageBtn.disabled = !enabled;
  els.attachBtn.disabled = !enabled;
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
}

function takeInput() {
  const text = els.input.value;
  els.input.value = '';
  autoGrow();
  return text;
}

async function readAttachments(files) {
  const out = [];
  for (const file of files) {
    out.push({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      data: await fileToDataUrl(file),
    });
  }
  return out;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function addAttachments(files) {
  state.attachments.push(...Array.from(files || []).slice(0, 8));
  renderAttachments();
  setComposerPanel(false);
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
  els.fileInput.value = '';
}

function renderAttachments() {
  els.attachList.innerHTML = '';
  for (const file of state.attachments) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'attachment-chip';
    item.textContent = `${file.type?.startsWith('image/') ? '图片' : '文件'} · ${file.name}`;
    item.addEventListener('click', () => {
      state.attachments = state.attachments.filter((entry) => entry !== file);
      renderAttachments();
    });
    els.attachList.appendChild(item);
  }
}

function scrollToBottom() {
  if (scrollFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}

function nearBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 140;
}

function scrollIfNear() {
  if (nearBottom()) scrollToBottom();
}

function openDrawer() {
  state.drawerView = 'projects';
  state.currentProject = null;
  renderDrawer();
  if (isDesktopLayout()) {
    els.drawer.classList.add('open');
    els.drawer.setAttribute('aria-hidden', 'false');
    els.backdrop.hidden = true;
    return;
  }
  els.backdrop.hidden = false;
  requestAnimationFrame(() => els.drawer.classList.add('open'));
  els.drawer.setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  if (isDesktopLayout()) {
    els.drawer.classList.add('open');
    els.drawer.setAttribute('aria-hidden', 'false');
    els.backdrop.hidden = true;
    return;
  }
  els.drawer.classList.remove('open');
  els.drawer.setAttribute('aria-hidden', 'true');
  els.backdrop.hidden = true;
}

function isDesktopLayout() {
  return typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches;
}

function syncViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  if (height && document.documentElement?.style?.setProperty) {
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
  }
}

function syncResponsiveShell() {
  syncViewportHeight();
  if (isDesktopLayout()) {
    els.drawer.classList.add('open');
    els.drawer.setAttribute('aria-hidden', 'false');
    els.backdrop.hidden = true;
  } else if (!els.drawer.classList.contains?.('open')) {
    els.drawer.setAttribute('aria-hidden', 'true');
  }
}

function setComposerPanel(open) {
  const next = Boolean(open);
  els.composerPanel.hidden = !next;
  els.moreBtn.setAttribute('aria-expanded', String(next));
  els.moreBtn.classList.toggle('is-open', next);
}

function toggleComposerPanel() {
  setComposerPanel(els.composerPanel.hidden);
}

function pickFiles(kind) {
  els.fileInput.accept = kind === 'image' ? 'image/*' : '';
  els.fileInput.click();
}

function setImageMode(enabled) {
  state.imageMode = Boolean(enabled);
  els.imageBtn.setAttribute('aria-pressed', String(state.imageMode));
  els.imageBtn.classList.toggle('is-active', state.imageMode);
}

function hasPushSupport() {
  return Boolean(
    state.push?.publicKey &&
      globalThis.navigator?.serviceWorker &&
      globalThis.PushManager &&
      globalThis.Notification,
  );
}

function syncPushButton() {
  if (!els.pushBtn) return;
  els.pushBtn.hidden = false;
  const supported = hasPushSupport();
  const permission = globalThis.Notification?.permission || 'default';
  const registered = state.pushStatus === 'registered';
  const checking = state.pushStatus === 'checking';
  els.pushBtn.disabled = !supported || permission === 'denied' || checking;
  els.pushBtn.classList.toggle('is-on', supported && permission === 'granted' && registered);
  if (!supported) {
    els.pushLabel.textContent = '通知不可用';
  } else if (permission === 'denied') {
    els.pushLabel.textContent = '通知被关闭';
  } else if (permission !== 'granted') {
    els.pushLabel.textContent = '开启通知';
  } else if (checking) {
    els.pushLabel.textContent = '注册中...';
  } else if (registered) {
    els.pushLabel.textContent = '通知已开';
  } else if (state.pushStatus === 'service-error') {
    els.pushLabel.textContent = '推送服务不可用';
  } else if (state.pushStatus === 'network-error') {
    els.pushLabel.textContent = '推送网络失败';
  } else if (state.pushStatus === 'failed') {
    els.pushLabel.textContent = '通知失败';
  } else {
    els.pushLabel.textContent = '需重新开启';
  }
}

async function enablePushNotifications() {
  if (!hasPushSupport()) {
    toast('当前浏览器不支持 Web Push');
    syncPushButton();
    return;
  }

  try {
    state.pushStatus = 'checking';
    state.pushIssue = '';
    syncPushButton();
    let permission = globalThis.Notification.permission;
    if (permission !== 'granted') {
      permission = await globalThis.Notification.requestPermission();
    }
    if (permission !== 'granted') {
      state.pushStatus = 'idle';
      toast('通知未开启');
      syncPushButton();
      return;
    }

    const registration = await globalThis.navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.push.publicKey),
      });
    }

    const serialized = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
    const data = await api('POST', '/api/mobile/push-subscriptions', {
      subscription: serialized,
      deviceName: pushDeviceName(),
      sessionId: state.currentSession?.id || '',
    });
    state.push = data.push || state.push;
    state.pushStatus = 'registered';
    state.pushIssue = '';
    syncPushButton();
    toast('通知已开启');
    api('POST', '/api/mobile/push/test', { sessionId: state.currentSession?.id || '' }).catch(() => {});
  } catch (error) {
    const failure = classifyPushError(error);
    state.pushStatus = failure.status;
    state.pushIssue = failure.message;
    reportPushDiagnostic({ stage: 'subscribe', failure, error }).catch(() => {});
    toast(failure.message);
    syncPushButton();
  }
}

function classifyPushError(error) {
  const raw = String(error?.message || error || '');
  const lower = raw.toLowerCase();
  if (lower.includes('push service error') || lower.includes('push service not available')) {
    return {
      status: 'service-error',
      message: '浏览器推送服务不可用：换 Chrome/Edge 或检查系统推送服务后重试',
    };
  }
  if (lower.includes('could not connect to push server') || lower.includes('network')) {
    return {
      status: 'network-error',
      message: '连接浏览器推送服务器失败：换网络后重试',
    };
  }
  if (lower.includes('sender_id') || lower.includes('applicationserverkey') || lower.includes('sender id')) {
    return {
      status: 'failed',
      message: '推送标识不匹配：刷新页面后重新开启通知',
    };
  }
  if (lower.includes('permission denied') || lower.includes('notallowed')) {
    return {
      status: 'failed',
      message: '通知权限被浏览器拒绝',
    };
  }
  return {
    status: 'failed',
    message: raw || '通知开启失败',
  };
}

async function reportPushDiagnostic({ stage, failure, error }) {
  await api('POST', '/api/mobile/push/diagnostics', {
    stage,
    status: failure?.status || 'failed',
    message: failure?.message || '',
    rawMessage: String(error?.message || error || ''),
    name: String(error?.name || ''),
    code: error?.code ?? null,
    permission: globalThis.Notification?.permission || '',
    hasServiceWorker: Boolean(globalThis.navigator?.serviceWorker),
    hasPushManager: Boolean(globalThis.PushManager),
    hasNotification: Boolean(globalThis.Notification),
    standalone: Boolean(
      globalThis.matchMedia?.('(display-mode: standalone)')?.matches ||
        globalThis.navigator?.standalone,
    ),
  });
}

async function refreshPushRegistrationStatus() {
  if (!hasPushSupport()) {
    syncPushButton();
    return;
  }
  if (globalThis.Notification.permission !== 'granted') {
    state.pushStatus = 'idle';
    syncPushButton();
    return;
  }

  state.pushStatus = 'checking';
  syncPushButton();
  try {
    const registration = await globalThis.navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      state.pushStatus = 'unregistered';
      syncPushButton();
      return;
    }
    const serialized = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
    const data = await api('POST', '/api/mobile/push-subscriptions/status', {
      endpoint: serialized.endpoint,
    });
    state.push = data.push || state.push;
    state.pushStatus = data.registered ? 'registered' : 'unregistered';
  } catch {
    state.pushStatus = 'failed';
    state.pushIssue = '无法确认通知注册状态';
  }
  syncPushButton();
}

function pushDeviceName() {
  const ua = globalThis.navigator?.userAgent || '';
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android';
  return '浏览器';
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = globalThis.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function unlockCompletionNotifier() {
  if (notifierUnlocked) return;
  notifierUnlocked = true;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;
  try {
    audioContext = audioContext || new AudioContextCtor();
    audioContext.resume?.().catch(() => {});
  } catch {
    audioContext = null;
  }
}

function notifyTurnComplete() {
  playCompletionTone();
  try {
    globalThis.navigator?.vibrate?.([70, 35, 70]);
  } catch {
    // 部分浏览器会在后台或省电模式拒绝震动，静默降级即可。
  }
}

function playCompletionTone() {
  if (!audioContext) return;
  try {
    audioContext.resume?.().catch(() => {});
    const start = audioContext.currentTime + 0.02;
    playTone(start, 880, 0.09);
    playTone(start + 0.14, 1175, 0.11);
  } catch {
    // 提醒音是增强反馈，失败不影响对话。
  }
}

function playTone(start, frequency, duration) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.06, start + 0.014);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.04);
}

function markCurrentActivity(at, text) {
  if (!state.currentSession?.id) return;
  const session = state.currentSession;
  session.updatedAt = at;
  session.startedAt ||= at;
  const project = findProjectForSession(session) || state.currentProject;
  if (!project) return;

  session.projectId ||= project.id;
  session.projectName ||= project.name;
  project.lastActivity = at;
  project.conversationCount = Math.max(Number(project.conversationCount || 0), 1);
  state.projects = sortProjectsByActivity(state.projects);

  if (state.currentProject?.id !== project.id) return;
  const existing = state.sessions.find((item) => item.id === session.id);
  const summary = {
    id: session.id,
    threadId: session.threadId || session.id,
    title: session.title || text?.slice(0, 60) || '对话',
    preview: text || existing?.preview || '',
    cwd: session.cwd,
    startedAt: session.startedAt,
    updatedAt: at,
    source: session.source || 'bridge',
    project: { id: project.id, name: project.name, path: project.path },
  };
  if (existing) Object.assign(existing, summary);
  else state.sessions.unshift(summary);
  state.sessions.sort((a, b) => toMillis(b.updatedAt || b.startedAt) - toMillis(a.updatedAt || a.startedAt));
}

function findProjectForSession(session) {
  if (session.projectId) {
    const exact = state.projects.find((project) => project.id === session.projectId);
    if (exact) return exact;
  }
  const sessionNorm = normPath(session.cwd);
  if (!sessionNorm) return null;
  let best = null;
  let bestLen = -1;
  for (const project of state.projects) {
    const projectNorm = normPath(project.path);
    if (!projectNorm) continue;
    if (sessionNorm === projectNorm || sessionNorm.startsWith(`${projectNorm}\\`)) {
      if (projectNorm.length > bestLen) {
        best = project;
        bestLen = projectNorm.length;
      }
    }
  }
  return best;
}

function sortProjectsByActivity(projects) {
  return [...projects].sort((a, b) => {
    const byTime = toMillis(b.lastActivity) - toMillis(a.lastActivity);
    if (byTime !== 0) return byTime;
    const byCount = Number(b.conversationCount || 0) - Number(a.conversationCount || 0);
    if (byCount !== 0) return byCount;
    return String(a.name || a.path || a.id).localeCompare(String(b.name || b.path || b.id));
  });
}

function openSettings() {
  els.baseUrlInput.value = config.baseUrl ? normalizeBridgeBaseUrl(config.baseUrl) : '';
  els.appIdInput.value = config.appId || '';
  els.settingsDialog.showModal();
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2800);
}

function emptyHint(text) {
  const el = document.createElement('div');
  el.className = 'session-empty';
  el.textContent = text;
  return el;
}

function rememberSession(sessionId) {
  if (sessionId) localStorage.setItem(LAST_SESSION_KEY, sessionId);
}

function setTitle(name) {
  els.title.textContent = name || 'Codex Chat';
}

function projectNameFromPath(value) {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || '';
}

function normPath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function toMillis(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function bindEvents() {
  syncResponsiveShell();
  document.addEventListener?.('pointerdown', unlockCompletionNotifier, { once: true, passive: true });
  document.addEventListener?.('keydown', unlockCompletionNotifier, { once: true });
  window.addEventListener?.('resize', syncResponsiveShell);
  window.visualViewport?.addEventListener?.('resize', syncResponsiveShell);
  window.visualViewport?.addEventListener?.('scroll', syncViewportHeight);
  window.matchMedia?.(DESKTOP_QUERY).addEventListener?.('change', syncResponsiveShell);

  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    setComposerPanel(false);
    send(takeInput());
  });
  els.input.addEventListener('input', autoGrow);
  els.input.addEventListener('focus', () => setComposerPanel(false));
  els.moreBtn.addEventListener('click', toggleComposerPanel);
  els.attachImageBtn.addEventListener('click', () => pickFiles('image'));
  els.attachBtn.addEventListener('click', () => pickFiles('file'));
  els.imageBtn.addEventListener('click', () => {
    setImageMode(!state.imageMode);
    els.hint.textContent = state.imageMode ? '本轮将请求 Codex 回图片' : '';
    setComposerPanel(false);
  });
  els.fileInput.addEventListener('change', () => addAttachments(els.fileInput.files));

  els.menuBtn.addEventListener('click', openDrawer);
  els.closeDrawer.addEventListener('click', closeDrawer);
  els.drawerBack.addEventListener('click', backToProjects);
  els.backdrop.addEventListener('click', closeDrawer);
  els.newBtn.addEventListener('click', () => newSession());
  els.drawerNew.addEventListener('click', () => newSession());
  els.pushBtn.addEventListener('click', enablePushNotifications);

  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsCancel.addEventListener('click', () => els.settingsDialog.close());
  els.settingsSave.addEventListener('click', async () => {
    const rawBase = els.baseUrlInput.value.trim();
    config.baseUrl = rawBase ? normalizeBridgeBaseUrl(rawBase) : '';
    config.appId = els.appIdInput.value.trim();
    saveConfig();
    els.settingsDialog.close();
    toast('已保存');
    try {
      await bootstrap();
    } catch (error) {
      toast(error.message);
    }
  });
}

async function init() {
  applyUrlConfig();
  bindEvents();
  autoGrow();
  try {
    await bootstrap();
  } catch (error) {
    renderPrompts();
    showWelcome();
    toast(error.message);
  }
}

init();
