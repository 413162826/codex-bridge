import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSecurityConfig } from './accessControl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(process.cwd());

// 项目级静态配置（随仓库提交，启动必带）。env 仍可覆盖，优先级：env > 配置文件 > 内置默认。
export const fileConfig = loadFileConfig();
const fileServer = fileConfig.server || {};
const fileCodex = fileConfig.codex || {};
const fileUi = fileConfig.ui || {};

export const defaultConfig = {
  server: {
    host: process.env.CODEX_BRIDGE_HOST || fileServer.host || '127.0.0.1',
    port: Number(process.env.CODEX_BRIDGE_PORT || fileServer.port || 4555),
    cors: fileServer.cors ?? true,
  },
  codex: {
    cwd: process.env.CODEX_BRIDGE_CWD || fileCodex.cwd || repoRoot,
    serviceName: process.env.CODEX_BRIDGE_SERVICE_NAME || fileCodex.serviceName || 'codex_bridge',
    model: process.env.CODEX_BRIDGE_MODEL || fileCodex.model || null,
    effort: process.env.CODEX_BRIDGE_EFFORT || fileCodex.effort || 'low',
    speed: process.env.CODEX_BRIDGE_SPEED || fileCodex.speed || 'balanced',
    approvalPolicy: process.env.CODEX_BRIDGE_APPROVAL_POLICY || fileCodex.approvalPolicy || 'never',
    sandbox: process.env.CODEX_BRIDGE_SANDBOX || fileCodex.sandbox || 'workspace-write',
    ephemeral: process.env.CODEX_BRIDGE_EPHEMERAL === '1' ? true : fileCodex.ephemeral ?? false,
    experimentalRawEvents: fileCodex.experimentalRawEvents ?? false,
    persistExtendedHistory: fileCodex.persistExtendedHistory ?? true,
  },
  ui: {
    refreshMs: fileUi.refreshMs ?? 1500,
    maxEventRows: fileUi.maxEventRows ?? 300,
    defaultSessionName: fileUi.defaultSessionName || 'New Codex Session',
  },
  security: createSecurityConfig(process.env, fileConfig.security || {}),
};

function loadFileConfig() {
  try {
    const raw = readFileSync(path.join(projectRoot, 'bridge.config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`忽略无法解析的 bridge.config.json：${error.message}`);
    }
    return {};
  }
}

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
