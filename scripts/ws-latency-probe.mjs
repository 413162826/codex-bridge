// 探针：验证“新建 session 第一句必慢、老 session 后续快”到底是按什么粒度触发的。
// 直接驱动 codex app-server（独立进程，不碰正在跑的 bridge），顺序跑：
//   A1 = 新 thread 第一轮
//   A2 = 同一 thread 第二轮
//   B1 = 另一个新 thread 第一轮
//   B2 = thread B 第二轮
// 每轮记录：到首个 token 的耗时(TTFT)、整轮耗时、重连次数、是否回退到 HTTPS。
// 用法: node scripts/ws-latency-probe.mjs [cwd]
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
  const rec = { label, reconnects: 0, fallback: false, ttftMs: null, totalMs: null, errs: [] };
  let firstDeltaAt = null;
  const onNote = (event) => {
    if (event.params?.threadId !== threadId) return;
    const m = event.method;
    if (m === 'item/agentMessage/delta' && firstDeltaAt === null) firstDeltaAt = performance.now();
    if (m === 'error') {
      rec.reconnects += 1;
      rec.errs.push(event.params?.error?.message || 'error');
    }
    if (m === 'warning' && /falling back from websockets to https/i.test(event.params?.message || '')) {
      rec.fallback = true;
    }
  };
  client.on('notification', onNote);
  const startedAt = performance.now();
  const completed = waitFor('turn/completed', threadId);
  await client.request('turn/start', { threadId, input: [{ type: 'text', text }], effort: 'low' });
  await completed;
  const doneAt = performance.now();
  client.off('notification', onNote);
  rec.ttftMs = Math.round((firstDeltaAt ?? doneAt) - startedAt);
  rec.totalMs = Math.round(doneAt - startedAt);
  console.log(
    `  [${label}] TTFT=${rec.ttftMs}ms total=${rec.totalMs}ms reconnects=${rec.reconnects} httpsFallback=${rec.fallback}` +
      (rec.errs.length ? `\n     errs: ${rec.errs.join(' | ')}` : ''),
  );
  return rec;
}

async function newThread() {
  const res = await client.request('thread/start', { cwd });
  return res.thread.id;
}

const PROMPT = '只回复两个字：收到。不要做任何其他事，不要调用工具。';

(async () => {
  const t0 = performance.now();
  await client.ensureStarted();
  console.log(`app-server 启动 + initialize: ${Math.round(performance.now() - t0)}ms\n`);

  const results = [];

  console.log('thread A:');
  const a = await newThread();
  results.push(await runTurn(a, PROMPT, 'A1 新session第1轮'));
  results.push(await runTurn(a, PROMPT, 'A2 同session第2轮'));

  console.log('\nthread B:');
  const b = await newThread();
  results.push(await runTurn(b, PROMPT, 'B1 新session第1轮'));
  results.push(await runTurn(b, PROMPT, 'B2 同session第2轮'));

  console.log('\n==== 结论速读 ====');
  console.table(
    results.map((r) => ({
      轮次: r.label,
      TTFT_ms: r.ttftMs,
      总耗时_ms: r.totalMs,
      重连次数: r.reconnects,
      回退HTTPS: r.fallback,
    })),
  );

  client.stop();
  process.exit(0);
})().catch((error) => {
  console.error('probe failed:', error.message);
  client.stop();
  process.exit(1);
});
