import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const CONFIG_KEY = 'codexChatMobile.config';
const LAST_SESSION_KEY = 'codexChatMobile.lastSessionId';
const APP_PATH = path.resolve('public/m/app.js');

test('mobile baseline: page Bridge URL is normalized before bootstrap', async () => {
  const h = installMobileHarness({
    search: '?appId=app-1&baseUrl=https%3A%2F%2Fbridge.kevinsu.xyz%2Fm%2Findex.html',
  });
  try {
    await importFreshMobileApp();
    await waitFor(() => h.calls.some((call) => call.path === '/api/mobile/bootstrap'));
    await waitFor(() => h.textContent().includes('历史消息'));

    const saved = JSON.parse(h.localStorage.getItem(CONFIG_KEY));
    assert.equal(saved.appId, 'app-1');
    assert.equal(saved.baseUrl, 'https://bridge.kevinsu.xyz');
    assert.equal(h.location.search, '');
    assert.equal(h.calls[0].path, '/api/mobile/bootstrap');
  } finally {
    h.cleanup();
  }
});

test('mobile baseline: default session sends one streamed turn and receives model text under 10s', async () => {
  const h = installMobileHarness({
    storedConfig: { appId: 'app-1', baseUrl: 'https://bridge.kevinsu.xyz' },
  });
  try {
    await importFreshMobileApp();
    await waitFor(() => h.calls.some((call) => call.path === '/api/mobile/bootstrap'));
    await waitFor(() => h.textContent().includes('历史消息'));

    const started = Date.now();
    h.elements.input.value = '继续这个会话';
    h.elements.composer.dispatch('submit', { preventDefault() {} });
    await waitFor(() => h.calls.some((call) => call.method === 'POST' && call.path === '/api/mobile/chat'));
    await waitFor(() => h.textContent().includes('模型返回'));

    const chat = h.calls.find((call) => call.method === 'POST' && call.path === '/api/mobile/chat');
    assert.equal(chat.body.sessionId, 'session-1');
    assert.equal(chat.body.text, '继续这个会话');
    assert.equal(Date.now() - started < 10_000, true);
  } finally {
    h.cleanup();
  }
});

test('mobile baseline: project history opens a session and continues via mobile chat', async () => {
  const h = installMobileHarness();
  try {
    await importFreshMobileApp();
    await waitFor(() => h.calls.some((call) => call.path === '/api/mobile/bootstrap'));
    await waitFor(() => h.elements.drawerList.children.length > 0);

    h.elements.menuBtn.dispatch('click');
    await waitFor(() => h.elements.drawerList.children.length > 0);
    const projectButton = h.elements.drawerList.children[0];
    projectButton.dispatch('click');
    await waitFor(() => h.calls.some((call) => call.path === '/api/mobile/projects/project-1/sessions'));
    await waitFor(() => h.elements.drawerList.children.length > 1);
    assert.equal(h.textContent().includes('最近'), true);

    const firstSessionButton = h.elements.drawerList.children[1];
    firstSessionButton.dispatch('click');
    await waitFor(() => h.calls.some((call) => call.path === '/api/mobile/sessions/thread-1?source=codex-history'));
    await waitFor(() => h.elements.title.textContent === '历史会话');

    h.elements.input.value = '接着说';
    h.elements.composer.dispatch('submit', { preventDefault() {} });
    await waitFor(() => h.calls.some((call) => call.method === 'POST' && call.path === '/api/mobile/chat'));

    const chat = h.calls.findLast((call) => call.method === 'POST' && call.path === '/api/mobile/chat');
    assert.equal(chat.body.sessionId, 'thread-1');
    assert.equal(h.textContent().includes('历史消息'), true);
  } finally {
    h.cleanup();
  }
});

async function importFreshMobileApp() {
  const url = `${pathToFileURL(APP_PATH).href}?case=${Date.now()}-${Math.random()}`;
  await import(url);
}

function installMobileHarness({ search = '', storedConfig = null } = {}) {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    localStorage: globalThis.localStorage,
    fetch: globalThis.fetch,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };

  const elements = createElements();
  const location = {
    origin: 'https://bridge.kevinsu.xyz',
    pathname: '/m/index.html',
    search,
    hash: '',
    href: `https://bridge.kevinsu.xyz/m/index.html${search}`,
  };
  const localStorage = createLocalStorage();
  if (storedConfig) localStorage.setItem(CONFIG_KEY, JSON.stringify(storedConfig));
  localStorage.setItem(LAST_SESSION_KEY, 'session-1');

  const calls = [];
  globalThis.location = location;
  globalThis.window = {
    history: {
      replaceState(_state, _title, url) {
        location.href = `https://bridge.kevinsu.xyz${url}`;
        const parsed = new URL(location.href);
        location.pathname = parsed.pathname;
        location.search = parsed.search;
        location.hash = parsed.hash;
      },
    },
    addEventListener() {},
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.document = {
    getElementById(id) {
      return elements[id] ?? (elements[id] = new FakeElement(id));
    },
    createElement(tag) {
      return new FakeElement(tag);
    },
  };
  globalThis.localStorage = localStorage;
  globalThis.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.origin);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: `${url.pathname}${url.search}`, headers: init.headers || {}, body });

    if (method === 'GET' && url.pathname === '/api/mobile/bootstrap') {
      return jsonResponse({
        prompts: [
          { id: 'p1', text: '总结当前项目' },
          { id: 'p2', text: '找风险' },
          { id: 'p3', text: '画一张图', mode: 'image' },
        ],
        projects: [{ id: 'project-1', name: '手机codex', path: 'D:\\repo', conversationCount: 1, lastActivity: '2026-06-15T00:10:00.000Z' }],
        defaultSession: {
          id: 'session-1',
          threadId: 'session-1',
          title: '手机codex',
          cwd: 'D:\\repo',
          messages: [{ role: 'assistant', text: '历史消息', status: 'done' }],
        },
      });
    }
    if (method === 'GET' && url.pathname === '/api/mobile/projects/project-1/sessions') {
      return jsonResponse({
        project: { id: 'project-1', name: '手机codex', path: 'D:\\repo' },
        sessions: [{
          id: 'thread-1',
          title: '历史会话',
          preview: '继续完善手机端体验',
          startedAt: '2026-06-15T00:00:00.000Z',
          updatedAt: '2026-06-15T00:10:00.000Z',
          source: 'codex-history',
        }],
      });
    }
    if (method === 'GET' && url.pathname === '/api/mobile/sessions/thread-1' && url.searchParams.get('source') === 'codex-history') {
      return jsonResponse({
        session: {
          id: 'thread-1',
          threadId: 'thread-1',
          title: '历史会话',
          cwd: 'D:\\repo',
          startedAt: '2026-06-15T00:00:00.000Z',
          updatedAt: '2026-06-15T00:10:00.000Z',
          messages: [{ role: 'assistant', text: '历史消息', status: 'done' }],
        },
      });
    }
    if (method === 'POST' && url.pathname === '/api/mobile/chat') {
      return sseResponse([
        'event: session',
        `data: {"sessionId":"${body.sessionId || 'new-session'}","threadId":"${body.sessionId || 'new-session'}","cwd":"D:\\\\repo"}`,
        '',
        'event: delta',
        'data: {"delta":"模型返回"}',
        '',
        'event: done',
        'data: {"status":"completed","finalText":"模型返回"}',
        '',
        '',
      ].join('\n'));
    }
    return jsonResponse({ error: { message: `unexpected ${method} ${url.pathname}${url.search}` } }, 404);
  };

  return {
    calls,
    elements,
    location,
    localStorage,
    textContent() {
      return Object.values(elements).map((element) => collectText(element)).join('\n');
    },
    cleanup() {
      Object.assign(globalThis, original);
    },
  };
}

function createElements() {
  const ids = [
    'messages',
    'welcome',
    'input',
    'composer',
    'sendBtn',
    'moreBtn',
    'composerPanel',
    'imageBtn',
    'attachImageBtn',
    'attachBtn',
    'fileInput',
    'attachList',
    'hint',
    'title',
    'menuBtn',
    'newBtn',
    'drawer',
    'backdrop',
    'closeDrawer',
    'drawerBack',
    'drawerTitle',
    'drawerNew',
    'drawerList',
    'pushBtn',
    'pushLabel',
    'settingsBtn',
    'settingsDialog',
    'baseUrlInput',
    'appIdInput',
    'settingsSave',
    'settingsCancel',
    'suggest',
    'toast',
  ];
  return Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]));
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.attributes = new Map();
    this.files = [];
    this.scrollHeight = 24;
    this.scrollTop = 0;
    this.clientHeight = 400;
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({ target: this, ...event });
    }
  }

  click() {
    this.dispatch('click');
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  remove() {
    this.removed = true;
  }

  focus() {
    this.focused = true;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  get childElementCount() {
    return this.children.length;
  }

  set innerHTML(_value) {
    this.children = [];
  }

  get innerHTML() {
    return '';
  }
}

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.names = new Set();
  }

  add(name) {
    this.names.add(name);
    this.sync();
  }

  remove(name) {
    this.names.delete(name);
    this.sync();
  }

  toggle(name, force) {
    if (force === true) this.names.add(name);
    else if (force === false) this.names.delete(name);
    else if (this.names.has(name)) this.names.delete(name);
    else this.names.add(name);
    this.sync();
  }

  contains(name) {
    return this.names.has(name);
  }

  sync() {
    this.element.className = [...this.names].join(' ');
  }
}

function createLocalStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function collectText(element) {
  return [element.textContent, ...element.children.map((child) => collectText(child))].filter(Boolean).join('\n');
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for condition');
}
