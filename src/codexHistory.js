// 读取 Codex 桌面端/CLI 的原生历史：把 ~/.codex/sessions 下的 rollout-*.jsonl 归到“项目”里，
// 供手机端浏览「项目 → 历史对话 → 进入续聊」。只读，不依赖 codex app-server 的未公开方法。
//
// 数据来源：
//   - 项目清单与顺序：~/.codex/.codex-global-state.json
//       · project-order / electron-saved-workspace-roots（工作区根，名字=文件夹名）
//       · thread-workspace-root-hints（threadId → 工作区根，用于把子目录里的对话归到项目）
//   - 对话本体：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//       · 首行 session_meta：{ payload: { id, cwd, timestamp } }
//       · 正文 event_msg：user_message / agent_message 即用户与助手的可见消息

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const INDEX_TTL_MS = 4000;
const MAX_THREADS_PER_PROJECT = 200;
const MAX_TRANSCRIPT_MESSAGES = 300;
const MAX_MESSAGE_CHARS = 8000;
const TAIL_SCAN_BYTES = 1024 * 1024;
const PREWARM_MARKER = '系统预热';
const MAX_PROFILE_SCAN_LINES = 5000;
// 有界并发：一次性并发打开成百上千个文件流会耗尽文件描述符（EMFILE）。
const SCAN_CONCURRENCY = 24;

export function resolveCodexHome() {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const primary = path.join(os.homedir(), '.codex');
  if (hasCodexState(primary)) return primary;
  if (process.platform === 'win32') {
    const adminHome = path.join(process.env.SystemDrive || 'C:', 'Users', 'Administrator', '.codex');
    if (hasCodexState(adminHome)) return adminHome;
  }
  return primary;
}

function hasCodexState(root) {
  return existsSync(path.join(root, 'sessions')) || existsSync(path.join(root, '.codex-global-state.json'));
}

export function createCodexHistory({ codexHome = resolveCodexHome() } = {}) {
  const sessionsDir = path.join(codexHome, 'sessions');
  const globalStatePath = path.join(codexHome, '.codex-global-state.json');

  let cache = null;
  let building = null;

  function readGlobalState() {
    try {
      const j = JSON.parse(readFileSync(globalStatePath, 'utf8'));
      const order = asArray(j['project-order']);
      const saved = asArray(j['electron-saved-workspace-roots']);
      const active = asArray(j['active-workspace-roots']);
      const hints = isObject(j['thread-workspace-root-hints']) ? j['thread-workspace-root-hints'] : {};
      const roots = [];
      const seen = new Set();
      for (const list of [order, saved, active]) {
        for (const raw of list) {
          const norm = normPath(raw);
          if (norm && !seen.has(norm)) {
            seen.add(norm);
            roots.push(raw);
          }
        }
      }
      return { roots, hints };
    } catch {
      return { roots: [], hints: {} };
    }
  }

  async function walkRollouts(dir) {
    const out = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await walkRollouts(full)));
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
    return out;
  }

  // 只读首行（session_meta），拿到 id / cwd / 开始时间。首行可能很大（含 base_instructions），
  // 用 readline 读到第一行即停，不会把整文件读进来。
  function readHeader(file) {
    return new Promise((resolve) => {
      const stream = createReadStream(file, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        rl.close();
        stream.destroy(); // readline 不会关闭底层流，必须显式销毁，否则 fd 泄漏 → EMFILE
        resolve(value);
      };
      rl.on('line', (line) => {
        try {
          const o = JSON.parse(line);
          const payload = o.payload || {};
          finish({ id: payload.id || null, cwd: payload.cwd || null, startedAt: payload.timestamp || o.timestamp || null });
        } catch {
          finish(null);
        }
      });
      rl.on('close', () => finish(null));
      stream.on('error', () => finish(null));
    });
  }

  // 读文件尾部的时间戳，作为“最近对话时间”。比全量扫描每个 rollout 轻很多，
  // 也比只看 session_meta 的开始时间更符合手机端“热度/最近”排序。
  async function readTailTimestamp(file) {
    let handle;
    try {
      handle = await open(file, 'r');
      const stat = await handle.stat();
      const length = Math.min(stat.size, 96 * 1024);
      if (!length) return null;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/).reverse();
      for (const line of lines.slice(0, 160)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const o = JSON.parse(trimmed);
          const ts = o.timestamp || o.payload?.timestamp || null;
          if (ts) return ts;
        } catch {
          // 尾部可能截到半行，继续向前找完整 JSON 行。
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  // 取该对话第一条“真实用户消息”，作为列表标题/预览（跳过预热轮的系统消息）。
  function readFirstUserMessage(file) {
    return new Promise((resolve) => {
      const stream = createReadStream(file, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let settled = false;
      let scanned = 0;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        rl.close();
        stream.destroy(); // 同上：早退时必须销毁底层流，避免 fd 泄漏
        resolve(value);
      };
      rl.on('line', (line) => {
        if (++scanned > 200) return finish('');
        try {
          const o = JSON.parse(line);
          if (o.type === 'event_msg' && o.payload?.type === 'user_message') {
            const raw = String(o.payload.message ?? o.payload.text ?? '');
            if (raw && !isPrewarm(raw)) finish(previewMessage(raw));
          }
        } catch {
          // 跳过坏行
        }
      });
      rl.on('close', () => finish(''));
      stream.on('error', () => finish(''));
    });
  }

  // 读完整对话，抽出有序的 user/agent 文本消息（与手机端展示一致：跳过推理/工具噪声）。
  function readTranscript(file) {
    return new Promise((resolve) => {
      const stream = createReadStream(file, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      const messages = [];
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        rl.close();
        stream.destroy();
        resolve(messages.slice(-MAX_TRANSCRIPT_MESSAGES));
      };
      rl.on('line', (line) => {
        try {
          const o = JSON.parse(line);
          if (o.type !== 'event_msg') return;
          const payload = o.payload || {};
          if (payload.type === 'user_message') {
            const raw = String(payload.message ?? payload.text ?? '');
            const text = transcriptMessage(raw);
            if (text && !isPrewarm(raw)) messages.push({ role: 'user', text, at: o.timestamp || null });
          } else if (payload.type === 'agent_message') {
            const text = String(payload.message ?? payload.text ?? '').trim().slice(0, MAX_MESSAGE_CHARS);
            if (text) messages.push({ role: 'assistant', text, at: o.timestamp || null });
          }
        } catch {
          // 跳过坏行
        }
      });
      rl.on('close', done);
      stream.on('error', done);
    });
  }

  // 从文件尾部反向找最近一条可见消息，只把 final_answer 当成“回答结束”。
  // commentary/status 只是电脑端工作过程提示，不能触发手机提醒。
  // 找到 final 后继续向前找它对应的最近一条用户消息，用作移动端通知标题。
  async function readLatestFinalAnswer(file) {
    let handle;
    try {
      handle = await open(file, 'r');
      const stat = await handle.stat();
      const length = Math.min(stat.size, TAIL_SCAN_BYTES);
      if (!length) return null;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/).reverse();
      let latest = null;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let o;
        try {
          o = JSON.parse(trimmed);
        } catch {
          // 尾部可能截断了超长 JSON 行，继续向前找完整行。
          continue;
        }
        if (o.type !== 'event_msg') continue;
        const payload = o.payload || {};
        if (!latest) {
          if (payload.type === 'user_message') {
            return null;
          }
          if (payload.type !== 'agent_message') continue;
          if (payload.phase !== 'final_answer') {
            return null;
          }
          const message = String(payload.message ?? payload.text ?? '').trim();
          if (!message) return null;
          latest = {
            at: o.timestamp || payload.timestamp || null,
            text: stripLongText(message),
            title: '',
          };
          continue;
        }

        if (payload.type !== 'user_message') continue;
        const raw = String(payload.message ?? payload.text ?? '');
        if (raw && !isPrewarm(raw)) {
          latest.title = previewMessage(raw);
          return latest;
        }
      }
      return latest;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function buildIndex() {
    const { roots, hints } = readGlobalState();
    const files = await walkRollouts(sessionsDir);
    const headers = await mapLimit(files, SCAN_CONCURRENCY, async (file) => {
      const header = await readHeader(file);
      if (!header?.cwd) return null;
      const updatedAt = (await readTailTimestamp(file)) || header.startedAt;
      return { ...header, updatedAt, file };
    });

    const registry = new Map(); // normPath -> project
    const ensureProject = (rawPath) => {
      const norm = normPath(rawPath);
      if (!norm) return null;
      let project = registry.get(norm);
      if (!project) {
        project = {
          id: hashPath(norm),
          name: baseName(rawPath),
          path: rawPath,
          norm,
          conversationCount: 0,
          lastActivity: null,
          threads: [],
        };
        registry.set(norm, project);
      }
      return project;
    };

    // 先按全局状态里的顺序登记项目（即使暂无对话，也保留以还原桌面端项目列表）。
    for (const root of roots) ensureProject(root);

    const hintMap = new Map();
    for (const [tid, root] of Object.entries(hints)) {
      if (root) hintMap.set(tid, root);
    }

    for (const header of headers) {
      if (!header || !header.id) continue;
      const rootPath = pickRoot(header, roots, hintMap) || header.cwd;
      const project = ensureProject(rootPath);
      if (!project) continue;
      project.threads.push({
        id: header.id,
        cwd: header.cwd,
        file: header.file,
        startedAt: header.startedAt,
        updatedAt: header.updatedAt || header.startedAt,
      });
      project.conversationCount += 1;
      if (header.updatedAt && (!project.lastActivity || header.updatedAt > project.lastActivity)) {
        project.lastActivity = header.updatedAt;
      }
    }

    const threadsById = new Map();
    for (const project of registry.values()) {
      project.threads.sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')));
      for (const thread of project.threads) {
        const prev = threadsById.get(thread.id);
        if (!prev || String(thread.updatedAt || thread.startedAt || '') > String(prev.updatedAt || prev.startedAt || '')) {
          threadsById.set(thread.id, { ...thread, projectId: project.id, projectName: project.name });
        }
      }
    }

    const orderIndex = new Map();
    roots.forEach((root, i) => orderIndex.set(normPath(root), i));
    const projects = [...registry.values()].sort((a, b) => {
      const ia = orderIndex.has(a.norm) ? orderIndex.get(a.norm) : Number.POSITIVE_INFINITY;
      const ib = orderIndex.has(b.norm) ? orderIndex.get(b.norm) : Number.POSITIVE_INFINITY;
      if (ia !== ib) return ia - ib;
      return String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
    });

    cache = {
      at: Date.now(),
      projects,
      projectById: new Map(projects.map((p) => [p.id, p])),
      threadsById,
      rootSet: new Set(roots.map(normPath).filter(Boolean)),
    };
    return cache;
  }

  async function ensureIndex() {
    if (cache && Date.now() - cache.at < INDEX_TTL_MS) return cache;
    if (building) return building;
    building = buildIndex().finally(() => {
      building = null;
    });
    return building;
  }

  async function listProjects() {
    const idx = await ensureIndex();
    return idx.projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      conversationCount: p.conversationCount,
      lastActivity: p.lastActivity,
    }));
  }

  async function listThreads(projectId) {
    const idx = await ensureIndex();
    const project = idx.projectById.get(projectId);
    if (!project) {
      const error = new Error(`未知 project：${projectId}`);
      error.statusCode = 404;
      throw error;
    }
    const slice = project.threads.slice(0, MAX_THREADS_PER_PROJECT);
    const data = await mapLimit(slice, SCAN_CONCURRENCY, async (thread) => {
      const preview = await readFirstUserMessage(thread.file);
      return {
        id: thread.id,
        title: preview || '(无标题对话)',
        preview,
        startedAt: thread.startedAt,
        updatedAt: thread.updatedAt || thread.startedAt,
        cwd: thread.cwd,
      };
    });
    return {
      project: { id: project.id, name: project.name, path: project.path, conversationCount: project.conversationCount },
      data,
      truncated: project.threads.length > MAX_THREADS_PER_PROJECT,
    };
  }

  async function getThread(threadId) {
    const idx = await ensureIndex();
    const entry = idx.threadsById.get(threadId);
    if (!entry) {
      const error = new Error(`未知对话：${threadId}`);
      error.statusCode = 404;
      throw error;
    }
    const [messages, firstUserMessage] = await Promise.all([readTranscript(entry.file), readFirstUserMessage(entry.file)]);
    return {
      id: threadId,
      cwd: entry.cwd,
      projectId: entry.projectId,
      projectName: entry.projectName,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt || entry.startedAt,
      title: firstUserMessage || messages.find((m) => m.role === 'user')?.text?.slice(0, 60) || '对话',
      messages,
    };
  }

  async function getThreadMeta(threadId) {
    const idx = await ensureIndex();
    const entry = idx.threadsById.get(threadId);
    if (!entry) return null;
    return { cwd: entry.cwd, projectId: entry.projectId, projectName: entry.projectName, rolloutPath: entry.file };
  }

  async function getThreadExecutionProfile(threadId) {
    const idx = await ensureIndex();
    const entry = idx.threadsById.get(threadId);
    if (!entry) return null;
    const profile = await readExecutionProfile(entry.file, {
      threadId,
      cwd: entry.cwd,
      projectId: entry.projectId,
      projectName: entry.projectName,
    });
    return profile && isCompleteExecutionProfile(profile) ? profile : null;
  }

  async function getProjectExecutionProfile(projectId) {
    const idx = await ensureIndex();
    const project = idx.projectById.get(projectId);
    if (!project) {
      const error = new Error(`未知 project：${projectId}`);
      error.statusCode = 404;
      throw error;
    }
    for (const thread of project.threads) {
      const profile = await getThreadExecutionProfile(thread.id);
      if (profile) {
        return {
          ...profile,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          inheritedFromThreadId: thread.id,
        };
      }
    }
    return null;
  }

  async function listRecentFinalAnswers({ limit = 24 } = {}) {
    const idx = await ensureIndex();
    const recent = [...idx.threadsById.entries()]
      .map(([id, thread]) => ({ id, ...thread }))
      .sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')))
      .slice(0, Math.max(1, limit));
    const data = await mapLimit(recent, Math.min(SCAN_CONCURRENCY, 8), async (thread) => {
      const latest = await readLatestFinalAnswer(thread.file);
      if (!latest) return null;
      const title = await readFirstUserMessage(thread.file);
      return {
        id: thread.id,
        threadId: thread.id,
        cwd: thread.cwd,
        file: thread.file,
        projectId: thread.projectId,
        projectName: thread.projectName,
        startedAt: thread.startedAt,
        updatedAt: latest.at || thread.updatedAt || thread.startedAt,
        assistantAt: latest.at || thread.updatedAt || thread.startedAt,
        assistantText: latest.text,
        title: latest.title || title || thread.projectName || 'Codex 回复完成',
      };
    });
    return data.filter(Boolean);
  }

  async function isProjectRoot(rawPath) {
    const norm = normPath(rawPath);
    if (!norm) return false;
    const idx = await ensureIndex();
    return idx.rootSet.has(norm);
  }

  function invalidate() {
    cache = null;
  }

  return {
    listProjects,
    listThreads,
    getThread,
    getThreadMeta,
    getThreadExecutionProfile,
    getProjectExecutionProfile,
    listRecentFinalAnswers,
    isProjectRoot,
    invalidate,
    codexHome,
  };
}

function readExecutionProfile(file, fallback = {}) {
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let scanned = 0;
    let latest = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      resolve(latest ? normalizeExecutionProfile(latest, { ...fallback, rolloutPath: file }) : null);
    };

    rl.on('line', (line) => {
      if (++scanned > MAX_PROFILE_SCAN_LINES) {
        finish();
        return;
      }
      try {
        const o = JSON.parse(line);
        if (o.type === 'turn_context' && o.payload) {
          latest = o.payload;
        }
      } catch {
        // 跳过坏行或被截断的行。
      }
    });
    rl.on('close', finish);
    stream.on('error', finish);
  });
}

function normalizeExecutionProfile(payload = {}, fallback = {}) {
  const sandboxPolicy = normalizeSandboxPolicy(payload.sandbox_policy || payload.sandboxPolicy);
  const permissionProfile = normalizePermissionProfile(payload.permission_profile || payload.permissionProfile);
  const approvalPolicy = normalizeApprovalPolicy(payload.approval_policy || payload.approvalPolicy);
  return {
    source: 'codex-rollout',
    threadId: fallback.threadId || null,
    cwd: payload.cwd || fallback.cwd || null,
    workspaceRoots: Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [],
    approvalPolicy,
    sandboxPolicy,
    permissionProfile,
    model: payload.model || null,
    effort: payload.effort || payload.collaboration_mode?.settings?.reasoning_effort || null,
    projectId: fallback.projectId || null,
    projectName: fallback.projectName || null,
    rolloutPath: fallback.rolloutPath || null,
  };
}

function isCompleteExecutionProfile(profile) {
  return Boolean(
    profile?.cwd &&
      profile?.approvalPolicy &&
      profile?.sandboxPolicy?.type &&
      profile?.permissionProfile?.type,
  );
}

function normalizeSandboxPolicy(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return { type: sandboxTypeToAppServer(value) };
  }
  if (!isObject(value)) return null;
  const type = sandboxTypeToAppServer(value.type);
  if (!type) return null;
  return { ...value, type };
}

function normalizePermissionProfile(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return { type: value };
  }
  if (!isObject(value) || !value.type) return null;
  return value;
}

function normalizeApprovalPolicy(value) {
  const text = String(value || '').trim();
  return text || null;
}

function sandboxTypeToAppServer(type) {
  switch (String(type || '').trim()) {
    case 'danger-full-access':
    case 'dangerFullAccess':
      return 'dangerFullAccess';
    case 'workspace-write':
    case 'workspaceWrite':
      return 'workspaceWrite';
    case 'read-only':
    case 'readOnly':
      return 'readOnly';
    case 'externalSandbox':
      return 'externalSandbox';
    default:
      return '';
  }
}

// 把一个 rollout 归到某个项目根：优先 thread-workspace-root-hints，其次取 cwd 的最长前缀匹配根。
function pickRoot(header, roots, hintMap) {
  const hinted = header.id && hintMap.get(header.id);
  if (hinted) return hinted;
  const cwdNorm = normPath(header.cwd);
  if (!cwdNorm) return null;
  let best = null;
  let bestLen = -1;
  for (const root of roots) {
    const rootNorm = normPath(root);
    if (!rootNorm) continue;
    if (cwdNorm === rootNorm || cwdNorm.startsWith(`${rootNorm}\\`)) {
      if (rootNorm.length > bestLen) {
        bestLen = rootNorm.length;
        best = root;
      }
    }
  }
  return best;
}

function isPrewarm(text) {
  return String(text || '').includes(PREWARM_MARKER);
}

// 列表标题：把 $imagegen 包装成「🖼️ 描述」，折叠空白并截断。
function previewMessage(text) {
  return cleanForTitle(text).replace(/\s+/g, ' ').slice(0, 120);
}

// 详情正文：保留换行，仅把 $imagegen 包装成可读描述，限制单条长度。
function transcriptMessage(text) {
  return cleanForTitle(text).slice(0, MAX_MESSAGE_CHARS);
}

function stripLongText(text) {
  return String(text || '').trim().slice(0, MAX_MESSAGE_CHARS);
}

function cleanForTitle(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (s.startsWith('$imagegen')) {
    const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return `🖼️ ${lines[lines.length - 1] || '图片生成'}`;
  }
  return s;
}

// 有界并发 map：最多同时跑 limit 个，避免一次性打开过多文件流耗尽 fd。
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  const size = Math.min(limit, items.length) || 0;
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normPath(p) {
  if (!p) return '';
  return String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function baseName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(p || '');
}

function hashPath(normalized) {
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}
