import { randomUUID } from 'node:crypto';

import { ensureWorkspace } from './stateStore.js';

export class AppRegistry {
  constructor({ apps = [] } = {}) {
    this.apps = new Map();
    for (const app of apps) {
      this.apps.set(app.appId, normalizeApp(app));
    }
  }

  list() {
    return [...this.apps.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(appId) {
    return this.apps.get(appId) || null;
  }

  require(appId) {
    const app = this.get(appId);
    if (!app) {
      const error = new Error(`未知 appId：${appId}`);
      error.statusCode = 404;
      throw error;
    }
    return app;
  }

  async createFromGlobal({ globalCodexConfig, name } = {}) {
    const appId = randomUUID();
    const workspaceRoot = await ensureWorkspace(appId);
    const now = new Date().toISOString();
    const app = normalizeApp({
      appId,
      name: name?.trim() || `App ${appId.slice(0, 8)}`,
      workspaceRoot,
      createdAt: now,
      updatedAt: now,
      defaults: {
        model: globalCodexConfig.model ?? null,
        effort: globalCodexConfig.effort ?? 'low',
        speed: globalCodexConfig.speed ?? 'balanced',
        approvalPolicy: globalCodexConfig.approvalPolicy ?? 'never',
        sandbox: globalCodexConfig.sandbox ?? 'workspace-write',
        ephemeral: globalCodexConfig.ephemeral ?? false,
        experimentalRawEvents: globalCodexConfig.experimentalRawEvents ?? false,
        persistExtendedHistory: globalCodexConfig.persistExtendedHistory ?? true,
        serviceName: globalCodexConfig.serviceName
          ? `${globalCodexConfig.serviceName}_${appId.slice(0, 8)}`
          : `codex_bridge_${appId.slice(0, 8)}`,
      },
    });
    this.apps.set(appId, app);
    return app;
  }

  update(appId, patch = {}) {
    const app = this.require(appId);
    if (typeof patch.name === 'string' && patch.name.trim()) {
      app.name = patch.name.trim();
    }
    if (patch.defaults && typeof patch.defaults === 'object') {
      Object.assign(app.defaults, sanitizeDefaultsPatch(patch.defaults, app.defaults));
    }
    app.updatedAt = new Date().toISOString();
    const normalized = normalizeApp(app);
    this.apps.set(appId, normalized);
    return normalized;
  }

  toJSON() {
    return this.list();
  }
}

export function resolveAppEffectiveCodexConfig({ app, globalCodexConfig }) {
  if (!app) {
    return { ...globalCodexConfig };
  }

  return {
    ...globalCodexConfig,
    ...app.defaults,
    cwd: app.workspaceRoot,
  };
}

function normalizeApp(app) {
  const now = new Date().toISOString();
  return {
    appId: app.appId,
    name: app.name || `App ${String(app.appId).slice(0, 8)}`,
    workspaceRoot: app.workspaceRoot,
    createdAt: app.createdAt || now,
    updatedAt: app.updatedAt || now,
    defaults: {
      model: app.defaults?.model ?? null,
      effort: app.defaults?.effort ?? 'low',
      speed: app.defaults?.speed ?? 'balanced',
      approvalPolicy: app.defaults?.approvalPolicy ?? 'never',
      sandbox: app.defaults?.sandbox ?? 'workspace-write',
      ephemeral: app.defaults?.ephemeral ?? false,
      experimentalRawEvents: app.defaults?.experimentalRawEvents ?? false,
      persistExtendedHistory: app.defaults?.persistExtendedHistory ?? true,
      serviceName: app.defaults?.serviceName || `codex_bridge_${String(app.appId).slice(0, 8)}`,
    },
  };
}

function sanitizeDefaultsPatch(defaults, currentDefaults = {}) {
  return {
    model: defaults.model ?? null,
    effort: defaults.effort ?? 'low',
    speed: defaults.speed ?? 'balanced',
    approvalPolicy: defaults.approvalPolicy ?? 'never',
    sandbox: defaults.sandbox ?? 'workspace-write',
    ephemeral: defaults.ephemeral ?? false,
    experimentalRawEvents: defaults.experimentalRawEvents ?? false,
    persistExtendedHistory: defaults.persistExtendedHistory ?? true,
    serviceName: defaults.serviceName || currentDefaults.serviceName || undefined,
  };
}
