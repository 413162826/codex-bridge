import { randomUUID } from 'node:crypto';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd());

export const defaultConfig = {
  server: {
    host: process.env.CODEX_BRIDGE_HOST || '127.0.0.1',
    port: Number(process.env.CODEX_BRIDGE_PORT || 4555),
    cors: true,
  },
  codex: {
    cwd: process.env.CODEX_BRIDGE_CWD || repoRoot,
    serviceName: process.env.CODEX_BRIDGE_SERVICE_NAME || 'codex_bridge',
    model: process.env.CODEX_BRIDGE_MODEL || null,
    effort: process.env.CODEX_BRIDGE_EFFORT || 'low',
    speed: process.env.CODEX_BRIDGE_SPEED || 'balanced',
    approvalPolicy: process.env.CODEX_BRIDGE_APPROVAL_POLICY || 'never',
    sandbox: process.env.CODEX_BRIDGE_SANDBOX || 'workspace-write',
    ephemeral: process.env.CODEX_BRIDGE_EPHEMERAL === '1' ? true : false,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  },
  ui: {
    refreshMs: 1500,
    maxEventRows: 300,
    defaultSessionName: 'New Codex Session',
  },
};

export function createRuntimeConfig() {
  return {
    ...structuredClone(defaultConfig),
    bridgeId: randomUUID(),
    startedAt: new Date().toISOString(),
    version: '0.1.0',
  };
}

export function mergeConfig(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] ??= {};
      mergeConfig(target[key], value);
      continue;
    }
    target[key] = value;
  }
  return target;
}
