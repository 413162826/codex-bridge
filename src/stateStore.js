import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const dataRoot = path.resolve(process.cwd(), 'data');
const stateFile = path.join(dataRoot, 'bridge-state.json');
const workspacesRoot = path.resolve(process.cwd(), 'workspaces');

export async function loadBridgeState() {
  await ensureRuntimeDirs();
  let raw;
  try {
    raw = await readFile(stateFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { config: {}, apps: [], sessions: [] };
    }
    throw error;
  }

  const parsed = parseStateLenient(raw);
  if (!parsed) {
    // 文件损坏且无法抢救：备份原文件后以空状态启动，避免整个服务起不来。
    try {
      await rename(stateFile, `${stateFile}.corrupt-${Date.now()}.bak`);
    } catch {
      // 备份失败也不致命，继续以空状态启动。
    }
    return { config: {}, apps: [], sessions: [] };
  }

  return {
    config: parsed.config && typeof parsed.config === 'object' ? parsed.config : {},
    apps: Array.isArray(parsed.apps) ? parsed.apps : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
  };
}

// 原子写：先写临时文件再 rename 覆盖，避免并发/中断写出半截 JSON。
// Node 的 fs.rename 在 Windows 上用 MoveFileEx(REPLACE_EXISTING)，同盘内是原子替换。
export async function saveBridgeState(state) {
  await ensureRuntimeDirs();
  const tmpFile = `${stateFile}.${process.pid}.tmp`;
  await writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmpFile, stateFile);
}

export async function ensureWorkspace(appId) {
  await ensureRuntimeDirs();
  const workspaceRoot = path.join(workspacesRoot, appId);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

export function getStateFilePath() {
  return stateFile;
}

export function getWorkspacesRoot() {
  return workspacesRoot;
}

// 容错解析：正常情况直接 JSON.parse；若是“有效 JSON + 尾部垃圾”这类损坏，
// 退而求其次，截到最长可解析前缀（旧版并发写盘 bug 会写出这种文件）。
export function parseStateLenient(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to salvage
  }

  let end = raw.length;
  for (let i = 0; i < 8 && end > 0; i += 1) {
    try {
      return JSON.parse(raw.slice(0, end));
    } catch (error) {
      const match = /position (\d+)/.exec(error.message || '');
      if (!match) {
        break;
      }
      const pos = Number(match[1]);
      if (!Number.isFinite(pos) || pos >= end) {
        break;
      }
      end = pos;
    }
  }
  return null;
}

async function ensureRuntimeDirs() {
  await mkdir(dataRoot, { recursive: true });
  await mkdir(workspacesRoot, { recursive: true });
}
