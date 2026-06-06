import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dataRoot = path.resolve(process.cwd(), 'data');
const stateFile = path.join(dataRoot, 'bridge-state.json');
const workspacesRoot = path.resolve(process.cwd(), 'workspaces');

export async function loadBridgeState() {
  await ensureRuntimeDirs();
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      config: parsed.config && typeof parsed.config === 'object' ? parsed.config : {},
      apps: Array.isArray(parsed.apps) ? parsed.apps : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { config: {}, apps: [] };
    }
    throw error;
  }
}

export async function saveBridgeState(state) {
  await ensureRuntimeDirs();
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
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

async function ensureRuntimeDirs() {
  await mkdir(dataRoot, { recursive: true });
  await mkdir(workspacesRoot, { recursive: true });
}
