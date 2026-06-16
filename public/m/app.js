// 手机端 Code Chat：只依赖 /api/mobile/* 契约，避免把管理台旧接口组合泄漏到前端。

const CONFIG_KEY = 'codexChatMobile.config';
const LAST_SESSION_KEY = 'codexChatMobile.lastSessionId';

const els = {
  messages: document.getElementById('messages'),
  welcome: document.getElementById('welcome'),
  input: document.getElementById('input'),
  composer: document.getElementById('composer'),
  sendBtn: document.getElementById('sendBtn'),
  imageBtn: document.getElementById('imageBtn'),
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
  let changed = false;
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

  if ((urlAppId || rawBase) && window.history?.replaceState) {
    params.delete('appId');
    params.delete('accessKey');
    params.delete('baseUrl');
    params.delete('bridge');
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
  state.projects = data.projects || [];
  state.prompts = data.prompts || [];
  renderPrompts();
  if (data.defaultSession) {
    openSessionObject(data.defaultSession);
  } else {
    newSession({ focus: false });
  }
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
    const res = await api('GET', `/api/mobile/sessions/${encodeURIComponent(sessionLike.id)}`);
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
      const meta = document.createElement('small');
      meta.textContent = formatTime(session.startedAt);
      btn.append(name, meta);
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
    const meta = document.createElement('small');
    meta.textContent = `${project.conversationCount || 0} 段对话${project.lastActivity ? ` · ${formatTime(project.lastActivity)}` : ''}`;
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

  hideWelcome();
  state.streaming = true;
  setComposerEnabled(false);
  els.hint.textContent = 'Codex 正在回复...';

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
    els.imageBtn.setAttribute('aria-pressed', 'false');
    setComposerEnabled(true);
    els.hint.textContent = '';
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
  els.imageBtn.disabled = !enabled;
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
    item.textContent = file.name;
    item.addEventListener('click', () => {
      state.attachments = state.attachments.filter((entry) => entry !== file);
      renderAttachments();
    });
    els.attachList.appendChild(item);
  }
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
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
  els.backdrop.hidden = false;
  requestAnimationFrame(() => els.drawer.classList.add('open'));
  els.drawer.setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  els.drawer.classList.remove('open');
  els.drawer.setAttribute('aria-hidden', 'true');
  els.backdrop.hidden = true;
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
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    send(takeInput());
  });
  els.input.addEventListener('input', autoGrow);
  els.imageBtn.addEventListener('click', () => {
    state.imageMode = !state.imageMode;
    els.imageBtn.setAttribute('aria-pressed', String(state.imageMode));
  });
  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => addAttachments(els.fileInput.files));

  els.menuBtn.addEventListener('click', openDrawer);
  els.closeDrawer.addEventListener('click', closeDrawer);
  els.drawerBack.addEventListener('click', backToProjects);
  els.backdrop.addEventListener('click', closeDrawer);
  els.newBtn.addEventListener('click', () => newSession());
  els.drawerNew.addEventListener('click', () => newSession());

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
