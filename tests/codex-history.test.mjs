import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexHistory } from '../src/codexHistory.js';

// 造一份临时 CODEX_HOME：一个 global-state + 两个 rollout，覆盖
// 项目顺序/命名、按 cwd 前缀归属、$imagegen 标题清洗、预热消息过滤、续聊元数据。
async function makeFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-hist-'));
  const projA = 'D:\\work\\alpha';
  const projB = 'D:\\work\\beta';

  await writeFile(
    path.join(home, '.codex-global-state.json'),
    JSON.stringify({
      'project-order': [projA, projB],
      'electron-saved-workspace-roots': [projA, projB],
      'thread-workspace-root-hints': {},
    }),
  );

  const day = path.join(home, 'sessions', '2026', '01', '01');
  await mkdir(day, { recursive: true });

  const rollout = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  // alpha：子目录的 cwd 仍应按前缀归到 alpha；首条是预热消息，应被跳过当标题。
  await writeFile(
    path.join(day, 'rollout-2026-01-01T10-00-00-aaaa.jsonl'),
    rollout([
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'aaaa', cwd: 'D:\\work\\alpha\\sub', timestamp: '2026-01-01T10:00:00.000Z' } },
      { timestamp: '2026-01-01T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '（系统预热，无需理会）' } },
      { timestamp: '2026-01-01T10:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: '帮我重构登录模块' } },
      { timestamp: '2026-01-01T10:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '好的，我先看下结构。' } },
    ]),
  );

  // beta：$imagegen 包装的用户消息，标题应被清洗成「🖼️ 描述」。
  await writeFile(
    path.join(day, 'rollout-2026-01-01T11-00-00-bbbb.jsonl'),
    rollout([
      { timestamp: '2026-01-01T11:00:00.000Z', type: 'session_meta', payload: { id: 'bbbb', cwd: projB, timestamp: '2026-01-01T11:00:00.000Z' } },
      { timestamp: '2026-01-01T11:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '$imagegen\n请生成并保存\n\n一只赛博朋克猫' } },
      { timestamp: '2026-01-01T11:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '已生成。' } },
    ]),
  );

  return { home, projA, projB };
}

test('listProjects 保留全局状态顺序与命名，统计对话数', async () => {
  const { home } = await makeFixture();
  try {
    const history = createCodexHistory({ codexHome: home });
    const projects = await history.listProjects();
    assert.equal(projects[0].name, 'alpha');
    assert.equal(projects[1].name, 'beta');
    const alpha = projects.find((p) => p.name === 'alpha');
    assert.equal(alpha.conversationCount, 1); // 子目录的对话按前缀归到 alpha
    assert.equal(alpha.lastActivity, '2026-01-01T10:00:00.000Z');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('listThreads 跳过预热消息、用首条真实用户消息当标题', async () => {
  const { home } = await makeFixture();
  try {
    const history = createCodexHistory({ codexHome: home });
    const projects = await history.listProjects();
    const alpha = projects.find((p) => p.name === 'alpha');
    const { data } = await history.listThreads(alpha.id);
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'aaaa');
    assert.equal(data[0].title, '帮我重构登录模块');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('getThread 返回有序文本记录并清洗 $imagegen 标题', async () => {
  const { home } = await makeFixture();
  try {
    const history = createCodexHistory({ codexHome: home });
    const thread = await history.getThread('bbbb');
    assert.equal(thread.cwd, 'D:\\work\\beta');
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages[0].role, 'user');
    assert.equal(thread.messages[0].text, '🖼️ 一只赛博朋克猫');
    assert.equal(thread.messages[1].role, 'assistant');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('getThreadMeta / isProjectRoot 支撑续聊与新建校验', async () => {
  const { home, projB } = await makeFixture();
  try {
    const history = createCodexHistory({ codexHome: home });
    const meta = await history.getThreadMeta('aaaa');
    assert.equal(meta.cwd, 'D:\\work\\alpha\\sub');
    assert.equal(meta.projectName, 'alpha');
    assert.equal(await history.getThreadMeta('missing'), null);
    assert.equal(await history.isProjectRoot(projB), true);
    assert.equal(await history.isProjectRoot('D:\\work\\alpha\\sub'), false); // 仅认项目根
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
