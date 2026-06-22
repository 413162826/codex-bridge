export async function resolveMobileSessionView(sessionId, { source = '', store, history, toBridgeSession, toNativeSession }) {
  const requestedSource = String(source || '').trim();

  if (requestedSource === 'bridge') {
    const bridgeSession = store.get(sessionId);
    if (bridgeSession) return toBridgeSession(bridgeSession);
    return toNativeSession(await history.getThread(sessionId));
  }

  if (requestedSource === 'codex-history') {
    return toNativeSession(await history.getThread(sessionId));
  }

  const nativeSession = await tryGetNativeSession(history, sessionId, toNativeSession);
  if (nativeSession) return nativeSession;

  const bridgeSession = store.get(sessionId);
  if (bridgeSession) return toBridgeSession(bridgeSession);

  return toNativeSession(await history.getThread(sessionId));
}

async function tryGetNativeSession(history, sessionId, toNativeSession) {
  try {
    return toNativeSession(await history.getThread(sessionId));
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}
