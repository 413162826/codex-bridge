import assert from 'node:assert/strict';
import test from 'node:test';

import { createNativeHistoryMonitor } from '../src/nativeHistoryMonitor.js';

function fakeHistory(initial = []) {
  let completions = initial;
  return {
    invalidateCount: 0,
    invalidate() {
      this.invalidateCount += 1;
    },
    set(next) {
      completions = next;
    },
    async listRecentFinalAnswers() {
      return completions;
    },
  };
}

function completion(overrides = {}) {
  return {
    id: 'thread-1',
    threadId: 'thread-1',
    title: '修通知',
    cwd: 'D:\\work\\codex-bridge',
    projectId: 'project-1',
    projectName: 'codex-bridge',
    assistantAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    assistantText: '已经修好了。',
    ...overrides,
  };
}

test('native history monitor seed 后只推新增 final_answer', async () => {
  const history = fakeHistory([completion()]);
  const published = [];
  const monitor = createNativeHistoryMonitor({
    history,
    store: { get: () => null },
    publish: (event) => published.push(event),
    now: () => new Date('2026-01-01T10:00:10.000Z'),
  });

  assert.equal(await monitor.seed(), 1);
  assert.equal(published.length, 0);

  history.set([
    completion(),
    completion({ assistantAt: '2026-01-01T10:01:00.000Z', updatedAt: '2026-01-01T10:01:00.000Z' }),
  ]);
  const result = await monitor.scan();

  assert.equal(result.published, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'bridge.mobile.unread');
  assert.equal(published[0].source, 'codex-history-monitor');
  assert.equal(published[0].sessionId, 'thread-1');
  assert.equal(published[0].updatedAt, '2026-01-01T10:01:00.000Z');
});

test('native history monitor 跳过 Bridge 已经处理的完成事件', async () => {
  const history = fakeHistory([completion()]);
  const published = [];
  const store = {
    get() {
      return {
        events: [
          {
            method: 'turn/completed',
            receivedAt: '2026-01-01T10:00:20.000Z',
          },
        ],
      };
    },
  };
  const monitor = createNativeHistoryMonitor({
    history,
    store,
    publish: (event) => published.push(event),
    now: () => new Date('2026-01-01T10:00:30.000Z'),
  });

  const result = await monitor.scan();

  assert.equal(result.published, 0);
  assert.equal(published.length, 0);
});
