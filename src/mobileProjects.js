export function orderMobileProjects(projects = [], defaultSession = null) {
  const defaultProjectId = findDefaultProjectId(projects, defaultSession);
  return [...projects].sort((a, b) => {
    if (defaultProjectId) {
      const aDefault = a.id === defaultProjectId;
      const bDefault = b.id === defaultProjectId;
      if (aDefault !== bDefault) return aDefault ? -1 : 1;
    }

    const byTime = toMillis(b.lastActivity) - toMillis(a.lastActivity);
    if (byTime !== 0) return byTime;
    return String(a.name || a.path || a.id).localeCompare(String(b.name || b.path || b.id));
  });
}

function findDefaultProjectId(projects, defaultSession) {
  if (!defaultSession) return null;
  if (defaultSession.projectId && projects.some((project) => project.id === defaultSession.projectId)) {
    return defaultSession.projectId;
  }

  const sessionNorm = normPath(defaultSession.cwd);
  if (!sessionNorm) return null;

  let best = null;
  let bestLen = -1;
  for (const project of projects) {
    const projectNorm = normPath(project.path);
    if (!projectNorm) continue;
    if (sessionNorm === projectNorm || sessionNorm.startsWith(`${projectNorm}\\`)) {
      if (projectNorm.length > bestLen) {
        best = project.id;
        bestLen = projectNorm.length;
      }
    }
  }
  return best;
}

function toMillis(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function normPath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}
