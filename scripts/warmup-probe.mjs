// 验证“首轮热身”的本质：同一 thread 内用【不同】prompt 连发几轮。
// 若第 2/3 轮（内容不同）依然明显快于第 1 轮，说明省下的是“连接 + 静态前缀(AGENTS/技能/环境)处理与缓存”，
// 与具体问题内容无关 —— 那么“后台预热”就能把这 ~10s 移出用户首句的关键路径。
// 反之若换内容后又变慢，则说明上次的“快”只是命中了完全相同 prompt 的缓存，预热无意义。
import { performance } from 'node:perf_hooks';
import { CodexAppServerClient } from '../src/codexAppServerClient.js';

const cwd = process.argv[2] || process.cwd();
const client = new CodexAppServerClient({ cwd });

function waitFor(method, threadId, timeoutMs = 220000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('notification', handler);
      reject(new Error(`timeout waiting ${method}`));
    }, timeoutMs);
    function handler(event) {
      if (event.method === method && event.params?.threadId === threadId) {
        clearTimeout(timer);
        client.off('notification', handler);
        resolve(event);
      }
    }
    client.on('notification', handler);
  });
}

async function runTurn(threadId, text, label) {
  let firstDeltaAt = null;
  let reconnects = 0;
  const onNote = (event) => {
    if (event.params?.threadId !== threadId) return;
    if (event.method === 'item/agentMessage/delta' && firstDeltaAt === null) firstDeltaAt = performance.now();
    if (event.method === 'error') reconnects += 1;
  };
  client.on('notification', onNote);
  const startedAt = performance.now();
  const completed = waitFor('turn/completed', threadId);
  await client.request('turn/start', { threadId, input: [{ type: 'text', text }], effort: 'low' });
  await completed;
  const doneAt = performance.now();
  client.off('notification', onNote);
  const ttft = Math.round((firstDeltaAt ?? doneAt) - startedAt);
  console.log(`  [${label}] TTFT=${ttft}ms total=${Math.round(doneAt - startedAt)}ms reconnects=${reconnects}  «${text.slice(0, 14)}»`);
  return ttft;
}

(async () => {
  await client.ensureStarted();

  // 不同内容、都极短输出
  const prompts = [
    '用一个英文单词回答：星期一怎么说？',
    '用一个词回答：法国的首都是哪里？',
    '用一个化学式回答：水的分子式是什么？',
    '用一个数字回答：7 乘以 8 等于多少？',
  ];

  console.log('同一 thread，逐轮换不同问题：');
  const t = (await client.request('thread/start', { cwd })).thread.id;
  for (let i = 0; i < prompts.length; i += 1) {
    await runTurn(t, prompts[i], i === 0 ? `第1轮(冷)` : `第${i + 1}轮(热,异内容)`);
  }

  console.log('\n对照：再开一个全新 thread 的第 1 轮（应再次变慢，证明是 per-thread）：');
  const t2 = (await client.request('thread/start', { cwd })).thread.id;
  await runTurn(t2, '用一个词回答：太阳系第三颗行星是？', '新thread第1轮(冷)');

  client.stop();
  process.exit(0);
})().catch((error) => {
  console.error('probe failed:', error.message);
  client.stop();
  process.exit(1);
});
