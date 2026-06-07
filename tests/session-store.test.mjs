import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionStore } from '../src/sessionStore.js';

const config = {
  codex: {
    cwd: 'D:\\repo',
    model: null,
    effort: 'low',
    speed: 'balanced',
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    ephemeral: false,
  },
  ui: {
    defaultSessionName: 'New Codex Session',
  },
};

test('SessionStore serializes and restores sessions for bridge restarts', () => {
  const store = new SessionStore();
  const session = store.createSession({
    thread: { id: 'thread-1', sessionId: 'codex-session-1' },
    request: {
      appId: 'app-1',
      name: '手机会话',
      cwd: 'D:\\repo\\workspaces\\app-1',
      effort: 'low',
      speed: 'balanced',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ephemeral: false,
    },
    config,
  });
  store.addUserMessage(session, {
    input: [{ type: 'text', text: '你好', text_elements: [] }],
    turnId: 'turn-1',
  });
  store.beginTurn(session, { turn: { id: 'turn-1', status: 'running' }, input: null });
  store.appendAssistantDelta({ threadId: 'thread-1', turnId: 'turn-1', delta: '你好，' });
  store.appendAssistantDelta({ threadId: 'thread-1', turnId: 'turn-1', delta: '手机。' });
  store.completeTurn({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });

  const restored = new SessionStore({ sessions: store.toJSON() });
  const restoredSession = restored.require('thread-1');

  assert.equal(restored.list().length, 1);
  assert.equal(restoredSession.appId, 'app-1');
  assert.equal(restoredSession.name, '手机会话');
  assert.equal(restoredSession.messages.length, 2);
  assert.equal(restoredSession.messages[1].text, '你好，手机。');
  assert.equal(restoredSession.activeTurnId, null);
});

test('SessionStore restores interrupted sessions as ready for future resume attempts', () => {
  const restored = new SessionStore({
    sessions: [
      {
        id: 'thread-2',
        threadId: 'thread-2',
        appId: 'app-1',
        name: '中断会话',
        status: 'running',
        activeTurnId: 'turn-2',
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:01:00.000Z',
        cwd: 'D:\\repo',
        model: null,
        effort: 'low',
        speed: 'balanced',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        ephemeral: false,
        thread: { id: 'thread-2' },
        messages: [{ id: 'm1', role: 'assistant', turnId: 'turn-2', text: '...', status: 'streaming' }],
        turns: [{ id: 'turn-2', status: 'running' }],
        events: [],
      },
    ],
  });

  const session = restored.require('thread-2');

  assert.equal(session.status, 'ready');
  assert.equal(session.activeTurnId, null);
  assert.equal(session.messages[0].status, 'interrupted');
  assert.equal(session.turns[0].status, 'interrupted');
});
