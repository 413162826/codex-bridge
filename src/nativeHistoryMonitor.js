import { existsSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';

const DEFAULT_INTERVAL_MS = 4000;
const DEFAULT_LIMIT = 24;
const DUPLICATE_WINDOW_MS = 90_000;
const DEFAULT_WATCH_DEBOUNCE_MS = 250;

export function createNativeHistoryMonitor({
  history,
  store,
  publish,
  intervalMs = DEFAULT_INTERVAL_MS,
  limit = DEFAULT_LIMIT,
  watchEnabled = true,
  watchPath = defaultWatchPath(history),
  watchFactory = fsWatch,
  watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS,
  now = () => new Date(),
} = {}) {
  if (!history || !store || !publish) {
    throw new Error('native history monitor requires history, store and publish');
  }

  const seen = new Set();
  let timer = null;
  let watcher = null;
  let watchScanTimer = null;
  let scanning = false;
  let seedPromise = null;

  async function seed({ before } = {}) {
    const completions = await readCompletions();
    let seeded = 0;
    for (const completion of completions) {
      if (!shouldSeedCompletion(completion, before)) continue;
      seen.add(keyForCompletion(completion));
      seeded += 1;
    }
    return seeded;
  }

  async function scan() {
    if (scanning) return { skipped: true };
    scanning = true;
    try {
      const completions = await readCompletions();
      let published = 0;
      for (const completion of completions) {
        const key = keyForCompletion(completion);
        if (seen.has(key)) continue;
        seen.add(key);
        trimSeen();
        if (hasRecentBridgeCompletion(completion)) continue;
        publish(buildUnreadEvent(completion, now()));
        published += 1;
      }
      return { scanned: completions.length, published };
    } finally {
      scanning = false;
    }
  }

  async function readCompletions() {
    history.invalidate?.();
    return history.listRecentFinalAnswers({ limit });
  }

  function start() {
    if (timer) return;
    const seedBefore = now();
    seedPromise = seed({ before: seedBefore }).catch((error) => publish(monitorError('seed', error, now())));
    timer = setInterval(() => {
      scan().catch((error) => publish(monitorError('scan', error, now())));
    }, intervalMs);
    timer.unref?.();
    startWatcher();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (watchScanTimer) clearTimeout(watchScanTimer);
    watchScanTimer = null;
    watcher?.close?.();
    watcher = null;
  }

  function startWatcher() {
    if (!watchEnabled || watcher) return false;
    if (!watchPath || !existsSync(watchPath)) {
      publish({
        type: 'bridge.native-history-monitor.watch.skipped',
        reason: 'missing_path',
        watchPath: watchPath || null,
        receivedAt: now().toISOString(),
      });
      return false;
    }

    try {
      watcher = watchFactory(watchPath, { recursive: true }, (eventType, filename) => {
        scheduleWatchScan(eventType, filename);
      });
      watcher?.on?.('error', (error) => publish(monitorError('watch', error, now())));
      watcher?.unref?.();
      publish({
        type: 'bridge.native-history-monitor.watch.started',
        watchPath,
        receivedAt: now().toISOString(),
      });
      return true;
    } catch (error) {
      publish(monitorError('watch.start', error, now()));
      return false;
    }
  }

  function scheduleWatchScan(eventType, filename) {
    if (watchScanTimer) clearTimeout(watchScanTimer);
    watchScanTimer = setTimeout(() => {
      watchScanTimer = null;
      Promise.resolve(seedPromise)
        .then(() => scan())
        .catch((error) => publish(monitorError('watch.scan', error, now())));
    }, watchDebounceMs);
    watchScanTimer.unref?.();
  }

  function hasRecentBridgeCompletion(completion) {
    const session = store.get(completion.threadId || completion.id);
    if (!session?.events?.length) return false;
    const target = Date.parse(completion.assistantAt || completion.updatedAt || '');
    if (!Number.isFinite(target)) return false;
    return session.events.some((event) => {
      if (event.method !== 'turn/completed') return false;
      const at = Date.parse(event.receivedAt || '');
      return Number.isFinite(at) && Math.abs(at - target) <= DUPLICATE_WINDOW_MS;
    });
  }

  function trimSeen() {
    while (seen.size > 500) {
      seen.delete(seen.values().next().value);
    }
  }

  return {
    start,
    stop,
    seed,
    scan,
    startWatcher,
    keyForCompletion,
    buildUnreadEvent: (completion) => buildUnreadEvent(completion, now()),
    _seen: seen,
  };
}

function defaultWatchPath(history) {
  return history?.codexHome ? path.join(history.codexHome, 'sessions') : null;
}

function shouldSeedCompletion(completion, before) {
  if (!before) return true;
  const beforeTime = before instanceof Date ? before.getTime() : Date.parse(before);
  if (!Number.isFinite(beforeTime)) return true;
  const completionTime = Date.parse(completion.assistantAt || completion.updatedAt || '');
  if (!Number.isFinite(completionTime)) return true;
  return completionTime < beforeTime;
}

function keyForCompletion(completion) {
  return `${completion.threadId || completion.id}|${completion.assistantAt || completion.updatedAt || ''}`;
}

function buildUnreadEvent(completion, receivedAt) {
  const title = completion.title || completion.projectName || 'Codex 回复完成';
  return {
    type: 'bridge.mobile.unread',
    sessionId: completion.threadId || completion.id,
    threadId: completion.threadId || completion.id,
    title,
    cwd: completion.cwd || '',
    projectId: completion.projectId || null,
    projectName: completion.projectName || projectNameFromPath(completion.cwd),
    updatedAt: completion.assistantAt || completion.updatedAt || receivedAt.toISOString(),
    source: 'codex-history-monitor',
    preview: completion.assistantText || '',
    receivedAt: receivedAt.toISOString(),
  };
}

function monitorError(stage, error, receivedAt) {
  return {
    type: 'bridge.native-history-monitor.error',
    stage,
    error: error?.message || String(error),
    receivedAt: receivedAt.toISOString(),
  };
}

function projectNameFromPath(value) {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || '';
}
