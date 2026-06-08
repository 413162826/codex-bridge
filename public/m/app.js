// 手机版 Codex Chat —— 直连 codex-bridge 的高级流式接口 /api/chat。
// 走 POST 承载的 SSE（EventSource 不能带 Authorization 头，所以手写 fetch + ReadableStream 解析）。

const CONFIG_KEY = 'codexChatMobile.config';

const els = {
  messages: document.getElementById('messages'),
  welcome: document.getElementById('welcome'),
  input: document.getElementById('input'),
  composer: document.getElementById('composer'),
  sendBtn: document.getElementById('sendBtn'),
  imageBtn: document.getElementById('imageBtn'),
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
  drawerView: 'projects', // 'projects' | 'threads'
  projects: [],
  currentProject: null,
  threads: [],
  currentSessionId: null,
  resumeNeeded: false, // 当前打开的是原生历史对话，发首句前需先 resume
  newChatCwd: null, // 在某项目下新建对话时的目标工作目录
  messages: [],
  streaming: false,
};

const messageEls = new Map();
let msgSeq = 0;

// ---------- 配置 / 鉴权 ----------
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
function baseUrl() {
  return String(config.baseUrl || location.origin).replace(/\/+$/, '');
}
function appId() {
  return (config.appId || '').trim();
}
function authHeaders() {
  return appId() ? { Authorization: `Bearer ${appId()}` } : {};
}

// ---------- 普通 JSON 请求 ----------
async function api(method, path, body) {
  const res = await fetch(baseUrl() + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error?.message || `${res.status} ${res.statusText}`);
  }
  return json;
}

// ---------- SSE over POST ----------
async function streamRequest(path, body, onEvent) {
  const res = await fetch(baseUrl() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      message = JSON.parse(text).error?.message || message;
    } catch {
      // 保留默认
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      onEvent(event, payload);
    }
  }
}

// ---------- 消息渲染 ----------
function addMessage(msg) {
  msg.id = `m${++msgSeq}`;
  msg.images = msg.images || [];
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
    const images = document.createElement('div');
    images.className = 'bubble-images';
    bubble.append(text, images);
    root.appendChild(bubble);
    els.messages.appendChild(root);
    entry = { root, bubble, text, images };
    messageEls.set(msg.id, entry);
  }

  entry.text.textContent = msg.error ? msg.error : msg.text;
  entry.text.style.color = msg.error ? 'var(--danger)' : '';
  const pending = msg.role === 'assistant' && msg.status === 'pending' && !msg.error && !msg.text;
  entry.bubble.classList.toggle('pending', pending);

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

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}
function nearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
}
function scrollIfNear() {
  if (nearBottom()) scrollToBottom();
}

// ---------- 发送 ----------
function buildImagePrompt(text) {
  return [
    `$imagegen ${text}`,
    '',
    '请直接生成这张图片，并保存为 PNG 到当前工作目录下的 codex-output/images/ 文件夹（文件名用英文），最后在回复里给出保存的相对路径。',
  ].join('\n');
}

async function send(rawText, { image = false } = {}) {
  const text = String(rawText || '').trim();
  if (!text || state.streaming) return;

  state.streaming = true;
  setComposerEnabled(false);
  hideWelcome();

  // 进入的是原生历史对话：发首句前先把线程恢复到 bridge，再走正常的 turns 流。
  if (state.currentSessionId && state.resumeNeeded) {
    els.hint.textContent = '正在恢复对话…';
    try {
      await api('POST', `/api/threads/${encodeURIComponent(state.currentSessionId)}/resume`);
      state.resumeNeeded = false;
    } catch (error) {
      els.hint.textContent = '';
      state.streaming = false;
      setComposerEnabled(true);
      toast('恢复对话失败：' + error.message);
      els.input.value = text; // 把字还回输入框，别丢
      autoGrow();
      return;
    }
  }

  els.hint.textContent = 'Codex 正在回复…';
  addMessage({ role: 'user', text });
  const assistant = addMessage({ role: 'assistant', text: '', status: 'pending' });
  scrollToBottom();

  const isNew = !state.currentSessionId;
  const payload = { text: image ? buildImagePrompt(text) : text };
  if (isNew && state.newChatCwd) payload.cwd = state.newChatCwd; // 在指定项目目录里新建
  const path = isNew
    ? '/api/chat'
    : `/api/sessions/${encodeURIComponent(state.currentSessionId)}/turns?stream=1`;

  try {
    await streamRequest(path, payload, (event, data) => {
      if (event === 'session') {
        if (!state.currentSessionId && data.sessionId) {
          state.currentSessionId = data.sessionId;
        }
      } else if (event === 'delta') {
        assistant.text += data.delta || '';
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
        // 连接波动（重连/回退 HTTPS）：提示这是网络超时而非模型在想。
        if (data.kind === 'reconnecting') {
          const counter = data.attempt && data.maxAttempts ? ` ${data.attempt}/${data.maxAttempts}` : '';
          els.hint.textContent = `连接中断，重连中${counter}…（网络超时，非模型耗时）`;
        } else if (data.kind === 'transport_fallback') {
          els.hint.textContent = '连接回退到 HTTPS，正在继续…';
        } else {
          els.hint.textContent = data.message || '连接波动，正在恢复…';
        }
      } else if (event === 'error') {
        assistant.error = data.message || '出错了';
        renderMessage(assistant);
      } else if (event === 'done') {
        if (data.finalText && !assistant.text) assistant.text = data.finalText;
      }
    });
  } catch (error) {
    assistant.error = assistant.text ? null : error.message;
    if (assistant.error) renderMessage(assistant);
    toast(error.message);
  } finally {
    assistant.status = 'done';
    renderMessage(assistant);
    state.streaming = false;
    setComposerEnabled(true);
    els.hint.textContent = '';
    if (isNew) state.newChatCwd = null; // 会话已建立，后续走 turns
    scrollToBottom();
  }
}

function setComposerEnabled(enabled) {
  els.input.disabled = !enabled;
  els.sendBtn.disabled = !enabled;
  els.imageBtn.disabled = !enabled;
}

// ---------- 项目 / 历史对话 ----------
async function loadProjects() {
  try {
    const res = await api('GET', '/api/projects');
    state.projects = res.data || [];
  } catch (error) {
    state.projects = [];
    toast(error.message);
  }
  if (state.drawerView === 'projects') renderDrawer();
}

function renderDrawer() {
  const list = els.drawerList;
  list.innerHTML = '';

  if (state.drawerView === 'threads' && state.currentProject) {
    els.drawerBack.hidden = false;
    els.drawerTitle.textContent = state.currentProject.name;

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'thread-new';
    newBtn.textContent = '＋ 在此项目新建对话';
    newBtn.addEventListener('click', () => newInProject(state.currentProject));
    list.appendChild(newBtn);

    if (!state.threads.length) {
      list.appendChild(emptyHint('该项目还没有对话记录。'));
      return;
    }
    for (const t of state.threads) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `session-item thread-item ${t.id === state.currentSessionId ? 'active' : ''}`;
      const name = document.createElement('strong');
      name.textContent = t.title || '(无标题对话)';
      const meta = document.createElement('small');
      meta.textContent = formatTime(t.startedAt);
      btn.append(name, meta);
      btn.addEventListener('click', () => openThread(t));
      list.appendChild(btn);
    }
    return;
  }

  // 项目列表
  els.drawerBack.hidden = true;
  els.drawerTitle.textContent = '项目';
  if (!state.projects.length) {
    list.appendChild(emptyHint('暂时没有读到项目历史。'));
    return;
  }
  for (const p of state.projects) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `session-item project-item ${p.conversationCount ? '' : 'muted'}`;
    const row = document.createElement('div');
    row.className = 'project-row';
    const name = document.createElement('strong');
    name.textContent = p.name;
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '›';
    row.append(name, chev);
    const meta = document.createElement('small');
    meta.textContent =
      `${p.conversationCount} 段对话` + (p.lastActivity ? ` · ${formatTime(p.lastActivity)}` : '');
    btn.append(row, meta);
    btn.addEventListener('click', () => openProject(p));
    list.appendChild(btn);
  }
}

function emptyHint(text) {
  const el = document.createElement('div');
  el.className = 'session-empty';
  el.textContent = text;
  return el;
}

async function openProject(project) {
  state.currentProject = project;
  state.drawerView = 'threads';
  state.threads = [];
  els.drawerBack.hidden = false;
  els.drawerTitle.textContent = project.name;
  els.drawerList.innerHTML = '<div class="session-empty">加载中…</div>';
  try {
    const res = await api('GET', `/api/projects/${encodeURIComponent(project.id)}/threads`);
    state.threads = res.data || [];
  } catch (error) {
    state.threads = [];
    toast(error.message);
  }
  if (state.drawerView === 'threads') renderDrawer();
}

function backToProjects() {
  state.drawerView = 'projects';
  state.currentProject = null;
  renderDrawer();
}

async function openThread(thread) {
  if (state.streaming) {
    toast('正在回复中，稍候再切换');
    return;
  }
  closeDrawer();
  try {
    const res = await api('GET', `/api/threads/${encodeURIComponent(thread.id)}`);
    const detail = res.thread;
    state.currentSessionId = detail.id;
    state.resumeNeeded = true; // 发首句时才真正 resume
    state.newChatCwd = null;
    clearMessages();
    hideWelcome();
    setTitle(thread.title || detail.title || state.currentProject?.name);
    for (const m of detail.messages || []) {
      if (m.role === 'assistant' && !String(m.text || '').trim()) continue;
      addMessage({ role: m.role, text: m.text || '', status: 'done' });
    }
    if (!state.messages.length) showWelcome();
    scrollToBottom();
  } catch (error) {
    toast(error.message);
  }
}

function newInProject(project) {
  if (state.streaming) {
    toast('正在回复中，稍候再新建');
    return;
  }
  state.newChatCwd = project.path;
  state.currentSessionId = null;
  state.resumeNeeded = false;
  clearMessages();
  showWelcome();
  setTitle(`新对话 · ${project.name}`);
  closeDrawer();
  els.input.focus();
  toast(`已选「${project.name}」，发消息即在此项目新建`);
}

function newSession() {
  if (state.streaming) {
    toast('正在回复中，稍候再新建');
    return;
  }
  state.currentSessionId = null;
  state.resumeNeeded = false;
  state.newChatCwd = null;
  state.drawerView = 'projects';
  state.currentProject = null;
  clearMessages();
  showWelcome();
  setTitle();
  closeDrawer();
  els.input.focus();
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

function setTitle(name) {
  els.title.textContent = name || 'Codex Chat';
}

// ---------- 抽屉 / 设置 ----------
function openDrawer() {
  state.drawerView = 'projects';
  state.currentProject = null;
  renderDrawer();
  loadProjects();
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
  els.baseUrlInput.value = config.baseUrl || '';
  els.appIdInput.value = config.appId || '';
  els.settingsDialog.showModal();
}

// ---------- toast ----------
let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2800);
}

// ---------- 输入框自适应 ----------
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

// ---------- 事件绑定 ----------
function bindEvents() {
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    send(takeInput(), { image: false });
  });
  els.imageBtn.addEventListener('click', () => {
    const text = els.input.value.trim();
    if (!text) {
      toast('先在输入框写图片描述，再点生成图片');
      els.input.focus();
      return;
    }
    send(takeInput(), { image: true });
  });
  els.input.addEventListener('input', autoGrow);

  els.menuBtn.addEventListener('click', openDrawer);
  els.closeDrawer.addEventListener('click', closeDrawer);
  els.drawerBack.addEventListener('click', backToProjects);
  els.backdrop.addEventListener('click', closeDrawer);
  els.newBtn.addEventListener('click', newSession);
  els.drawerNew.addEventListener('click', newSession);

  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsCancel.addEventListener('click', () => els.settingsDialog.close());
  els.settingsSave.addEventListener('click', () => {
    config.baseUrl = els.baseUrlInput.value.trim();
    config.appId = els.appIdInput.value.trim();
    saveConfig();
    els.settingsDialog.close();
    toast('已保存');
    loadProjects();
  });

  els.suggest.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.image) send(btn.dataset.image, { image: true });
    else if (btn.dataset.prompt) send(btn.dataset.prompt, { image: false });
  });
}

// ---------- 启动 ----------
function init() {
  bindEvents();
  autoGrow();
  loadProjects();
}

init();
