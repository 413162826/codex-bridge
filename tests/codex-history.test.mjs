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
      { timestamp: '2026-01-01T10:00:00.500Z', type: 'turn_context', payload: { cwd: 'D:\\work\\alpha\\sub', workspace_roots: ['D:\\work\\alpha'], approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' }, permission_profile: { type: 'disabled' }, model: 'gpt-5.5', effort: 'xhigh' } },
      { timestamp: '2026-01-01T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '（系统预热，无需理会）' } },
      { timestamp: '2026-01-01T10:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: '帮我重构登录模块' } },
      { timestamp: '2026-01-01T10:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '好的，我先看下结构。', phase: 'commentary' } },
    ]),
  );

  // beta：$imagegen 包装的用户消息，标题应被清洗成「🖼️ 描述」。
  await writeFile(
    path.join(day, 'rollout-2026-01-01T11-00-00-bbbb.jsonl'),
    rollout([
      { timestamp: '2026-01-01T11:00:00.000Z', type: 'session_meta', payload: { id: 'bbbb', cwd: projB, timestamp: '2026-01-01T11:00:00.000Z' } },
      { timestamp: '2026-01-01T11:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '$imagegen\n请生成并保存\n\n一只赛博朋克猫' } },
      { timestamp: '2026-01-01T11:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '已生成。', phase: 'final_answer' } },
    ]),
  );

  // alpha2：最新可见消息是 user，说明还在等待模型，不应把上一条 final_answer 当新完成。
  await writeFile(
    path.join(day, 'rollout-2026-01-01T12-00-00-cccc.jsonl'),
    rollout([
      { timestamp: '2026-01-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'cccc', cwd: projB, timestamp: '2026-01-01T12:00:00.000Z' } },
      { timestamp: '2026-01-01T12:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '上一轮问题' } },
      { timestamp: '2026-01-01T12:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '上一轮回答。', phase: 'final_answer' } },
      { timestamp: '2026-01-01T12:00:03.000Z', type: 'event_msg', payload: { type: 'user_message', message: '新问题' } },
    ]),
  );

  // beta2：同一线程多轮完成时，通知标题应取最后一轮提问，而不是第一轮标题。
  await writeFile(
    path.join(day, 'rollout-2026-01-01T13-00-00-dddd.jsonl'),
    rollout([
      { timestamp: '2026-01-01T13:00:00.000Z', type: 'session_meta', payload: { id: 'dddd', cwd: projB, timestamp: '2026-01-01T13:00:00.000Z' } },
      { timestamp: '2026-01-01T13:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '这是很早以前的第一条问题' } },
      { timestamp: '2026-01-01T13:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '第一轮回答。', phase: 'final_answer' } },
      { timestamp: '2026-01-01T13:00:03.000Z', type: 'event_msg', payload: { type: 'user_message', message: '最后一次提问的内容是什么？' } },
      { timestamp: '2026-01-01T13:00:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '这是最后一轮回答。', phase: 'final_answer' } },
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
    assert.equal(alpha.lastActivity, '2026-01-01T10:00:03.000Z');
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
    assert.equal(data[0].updatedAt, '2026-01-01T10:00:03.000Z');
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
    assert.equal(thread.title, '🖼️ 一只赛博朋克猫');
    assert.equal(thread.updatedAt, '2026-01-01T11:00:02.000Z');
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

test('getThreadExecutionProfile 读取桌面 turn_context 并转换 sandboxPolicy', async () => {
  const { home } = await makeFixture();
  try {
    const history = createCodexHistory({ codexHome: home });
    const profile = await history.getThreadExecutionProfile('aaaa');
    assert.equal(profile.cwd, 'D:\\work\\alpha\\sub');
    assert.equal(profile.approvalPolicy, 'never');
    assert.equal(profile.sandboxPolicy.type, 'dangerFullAccess');
    assert.equal(profile.permissionProfile.type, 'disabled');
    assert.equal(profile.model, 'gpt-5.5');
    assert.equal(profile.effort, 'xhigh');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('getProjectExecutionProfile 复用项目最新可用桌面画像', async () => {
  const { home } = await makeFixture();
  try {
    const history = createCodexHistory({ codexHome: home });
    const projects = await history.listProjects();
    const alpha = projects.find((p) => p.name === 'alpha');
    const profile = await history.getProjectExecutionProfile(alpha.id);
    assert.equal(profile.cwd, 'D:\\work\\alpha\\sub');
    assert.equal(profile.inheritedFromThreadId, 'aaaa');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('listRecentFinalAnswers 只返回最近已完成的 final_answer', async () => {
  const { home } = await makeFixture();
  try {
    const history = createCodexHistory({ codexHome: home });
    const finals = await history.listRecentFinalAnswers({ limit: 5 });
    assert.deepEqual(finals.map((item) => item.id), ['dddd', 'bbbb']);
    assert.equal(finals[0].assistantText, '这是最后一轮回答。');
    assert.equal(finals[0].title, '最后一次提问的内容是什么？');
    assert.equal(finals[0].assistantAt, '2026-01-01T13:00:04.000Z');
    assert.equal(finals[1].assistantText, '已生成。');
    assert.equal(finals[1].title, '🖼️ 一只赛博朋克猫');
    assert.equal(finals[1].assistantAt, '2026-01-01T11:00:02.000Z');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
