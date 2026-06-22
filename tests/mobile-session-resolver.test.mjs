import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMobileSessionView } from '../src/mobileSessionResolver.js';

function makeDeps() {
  const bridge = { id: 'same-id', source: 'bridge', title: 'Bridge 缓存会话' };
  const native = { id: 'same-id', source: 'codex-history', title: '原生历史会话' };
  return {
    store: {
      get(id) {
        return id === 'same-id' ? bridge : null;
      },
    },
    history: {
      async getThread(id) {
        if (id !== 'same-id') {
          const error = new Error('missing');
          error.statusCode = 404;
          throw error;
        }
        return native;
      },
    },
    toBridgeSession(session) {
      return session;
    },
    toNativeSession(session) {
      return session;
    },
  };
}

test('resolveMobileSessionView 默认优先返回原生历史，避免同 id Bridge 缓存遮挡列表项', async () => {
  const resolved = await resolveMobileSessionView('same-id', makeDeps());
  assert.equal(resolved.source, 'codex-history');
  assert.equal(resolved.title, '原生历史会话');
});

test('resolveMobileSessionView 可通过 source=bridge 明确读取 Bridge 会话', async () => {
  const resolved = await resolveMobileSessionView('same-id', { ...makeDeps(), source: 'bridge' });
  assert.equal(resolved.source, 'bridge');
  assert.equal(resolved.title, 'Bridge 缓存会话');
});

test('resolveMobileSessionView 可通过 source=codex-history 明确读取原生历史', async () => {
  const resolved = await resolveMobileSessionView('same-id', { ...makeDeps(), source: 'codex-history' });
  assert.equal(resolved.source, 'codex-history');
  assert.equal(resolved.title, '原生历史会话');
});
