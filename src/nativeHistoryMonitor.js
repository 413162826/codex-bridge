const DEFAULT_INTERVAL_MS = 4000;
const DEFAULT_LIMIT = 24;
const DUPLICATE_WINDOW_MS = 90_000;

export function createNativeHistoryMonitor({
  history,
  store,
  publish,
  intervalMs = DEFAULT_INTERVAL_MS,
  limit = DEFAULT_LIMIT,
  now = () => new Date(),
} = {}) {
  if (!history || !store || !publish) {
    throw new Error('native history monitor requires history, store and publish');
  }

  const seen = new Set();
  let timer = null;
  let scanning = false;

  async function seed() {
    const completions = await readCompletions();
    for (const completion of completions) {
      seen.add(keyForCompletion(completion));
    }
    return completions.length;
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
    seed().catch((error) => publish(monitorError('seed', error, now())));
    timer = setInterval(() => {
      scan().catch((error) => publish(monitorError('scan', error, now())));
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
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
    keyForCompletion,
    buildUnreadEvent: (completion) => buildUnreadEvent(completion, now()),
    _seen: seen,
  };
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
