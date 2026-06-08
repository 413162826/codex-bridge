import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionStore, classifyConnectionNotice } from '../src/sessionStore.js';

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

test('classifyConnectionNotice tags WebSocket reconnect errors as connection timeouts', () => {
  const notice = classifyConnectionNotice('error', {
    threadId: 'thread-x',
    willRetry: true,
    error: {
      message: 'Reconnecting... 3/5',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: 'timeout waiting for child process to exit',
    },
  });
  assert.equal(notice.kind, 'reconnecting');
  assert.equal(notice.reason, 'connection_timeout');
  assert.equal(notice.transport, 'websocket');
  assert.equal(notice.attempt, 3);
  assert.equal(notice.maxAttempts, 5);
  assert.equal(notice.willRetry, true);
});

test('classifyConnectionNotice tags the HTTPS fallback warning', () => {
  const notice = classifyConnectionNotice('warning', {
    threadId: 'thread-x',
    message: 'Falling back from WebSockets to HTTPS transport. timeout waiting for child process to exit',
  });
  assert.equal(notice.kind, 'transport_fallback');
  assert.equal(notice.transport, 'https');
});

test('classifyConnectionNotice ignores unrelated warnings', () => {
  assert.equal(
    classifyConnectionNotice('warning', { threadId: 't', message: 'Exceeded skills context budget of 2%.' }),
    null,
  );
});

test('prewarm (ephemeral) turns leave no trace in the visible session', () => {
  const store = new SessionStore();
  store.createSession({ thread: { id: 'thread-pw', sessionId: 'c' }, request: {}, config });
  const session = store.require('thread-pw');
  session.prewarming = true; // server 在发预热 turn 前会置位

  // 预热轮的 turn/started：登记为 ephemeral，不建可见 turn/message。
  store.applyNotification({
    method: 'turn/started',
    receivedAt: 't1',
    params: { threadId: 'thread-pw', turn: { id: 'warm-turn' } },
  });
  // 预热轮的 delta / completed：完全忽略。
  store.applyNotification({
    method: 'item/agentMessage/delta',
    receivedAt: 't2',
    params: { threadId: 'thread-pw', turnId: 'warm-turn', delta: '好' },
  });
  store.applyNotification({
    method: 'turn/completed',
    receivedAt: 't3',
    params: { threadId: 'thread-pw', turn: { id: 'warm-turn', status: 'interrupted' } },
  });

  assert.equal(store.require('thread-pw').turns.length, 0, '预热轮不应产生可见 turn');
  assert.equal(store.require('thread-pw').messages.length, 0, '预热轮不应产生可见 message');
  assert.equal(store.isEphemeralTurn('warm-turn'), false, '预热轮结束后应清理 ephemeral 登记');
  assert.equal(store.require('thread-pw').prewarming, false, '预热结束后 prewarming 标记应复位');

  // 之后真实轮应正常建可见 turn。
  store.applyNotification({
    method: 'turn/started',
    receivedAt: 't4',
    params: { threadId: 'thread-pw', turn: { id: 'real-turn' } },
  });
  assert.equal(store.require('thread-pw').turns.length, 1);
  assert.equal(store.require('thread-pw').turns[0].id, 'real-turn');
});

test('applyNotification records a connection notice and clears it once deltas resume', () => {
  const store = new SessionStore();
  store.createSession({
    thread: { id: 'thread-3', sessionId: 'codex-3' },
    request: {},
    config,
  });

  store.applyNotification({
    method: 'error',
    receivedAt: '2026-06-08T00:00:01.000Z',
    params: {
      threadId: 'thread-3',
      willRetry: true,
      error: { message: 'Reconnecting... 2/5', codexErrorInfo: { responseStreamDisconnected: {} } },
    },
  });
  assert.equal(store.require('thread-3').lastNotice.kind, 'reconnecting');

  store.applyNotification({
    method: 'item/agentMessage/delta',
    receivedAt: '2026-06-08T00:00:05.000Z',
    params: { threadId: 'thread-3', turnId: 'turn-3', delta: 'hi' },
  });
  assert.equal(store.require('thread-3').lastNotice, null);
});
