import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

async function waitFor(predicate, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('等待 watcher 触发扫描超时');
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

test('native history monitor 监听 sessions 文件变化并触发扫描', async (t) => {
  const watchPath = await mkdtemp(path.join(os.tmpdir(), 'codex-history-watch-'));
  t.after(() => rm(watchPath, { recursive: true, force: true }));

  const history = fakeHistory([completion()]);
  const published = [];
  const watcher = new EventEmitter();
  let watchCallback = null;
  let watchArgs = null;
  let closeCount = 0;
  watcher.close = () => {
    closeCount += 1;
  };
  watcher.unref = () => {};

  const monitor = createNativeHistoryMonitor({
    history,
    store: { get: () => null },
    publish: (event) => published.push(event),
    intervalMs: 60_000,
    watchPath,
    watchDebounceMs: 1,
    watchFactory: (target, options, callback) => {
      watchArgs = { target, options };
      watchCallback = callback;
      return watcher;
    },
    now: () => new Date('2026-01-01T10:00:10.000Z'),
  });

  monitor.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(watchArgs.target, watchPath);
  assert.equal(watchArgs.options.recursive, true);
  assert.equal(typeof watchCallback, 'function');
  assert.equal(published.some((event) => event.type === 'bridge.native-history-monitor.watch.started'), true);

  history.set([
    completion(),
    completion({ assistantAt: '2026-01-01T10:02:00.000Z', updatedAt: '2026-01-01T10:02:00.000Z' }),
  ]);
  watchCallback('change', '2026\\01\\01\\rollout-test.jsonl');

  await waitFor(() => published.some((event) => event.type === 'bridge.mobile.unread'));

  const unread = published.find((event) => event.type === 'bridge.mobile.unread');
  assert.equal(unread.source, 'codex-history-monitor');
  assert.equal(unread.updatedAt, '2026-01-01T10:02:00.000Z');

  monitor.stop();
  assert.equal(closeCount, 1);
});
