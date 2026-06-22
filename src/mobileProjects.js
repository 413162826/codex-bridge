export function orderMobileProjects(projects = [], defaultSession = null) {
  void defaultSession;
  return [...projects].sort((a, b) => {
    const byTime = toMillis(b.lastActivity) - toMillis(a.lastActivity);
    if (byTime !== 0) return byTime;
    const byCount = Number(b.conversationCount || 0) - Number(a.conversationCount || 0);
    if (byCount !== 0) return byCount;
    return String(a.name || a.path || a.id).localeCompare(String(b.name || b.path || b.id));
  });
}

function toMillis(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}
