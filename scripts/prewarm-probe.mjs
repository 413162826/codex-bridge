// 端到端验证方案 A：用真实的 SessionStore + CodexAppServerClient，复刻 server 的
// prewarm/settle 逻辑，检验 (1) 预热后用户首句是否变快 (2) 预热轮是否对会话零污染。
import { performance } from 'node:perf_hooks';
import { CodexAppServerClient } from '../src/codexAppServerClient.js';
import { SessionStore } from '../src/sessionStore.js';

const cwd = process.argv[2] || process.cwd();
const client = new CodexAppServerClient({ cwd });
const store = new SessionStore();
client.on('notification', (e) => store.applyNotification(e)); // 跟 server 一样：通知喂给 store

const config = {
  codex: { cwd, model: null, effort: 'low', speed: 'balanced', approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: false },
  ui: { defaultSessionName: 'probe' },
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PREWARM_INPUT = [{ type: 'text', text: '（系统预热，无需理会：只回复一个字“好”）' }];

function prewarmSession(session) {
  if (!session || session._prewarm) return;
  const marker = { turnId: null, warmReady: false, done: false, promise: null };
  session._prewarm = marker;
  session.prewarming = true;
  marker.promise = (async () => {
    let onNote = null;
    try {
      const result = await client.request('turn/start', { threadId: session.threadId, input: PREWARM_INPUT, model: session.model, effort: 'low' });
      marker.turnId = result.turn.id;
      store.registerEphemeralTurn(marker.turnId);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 60000);
        onNote = (event) => {
          if (event.params?.threadId !== session.threadId) return;
          const tid = event.params?.turnId || event.params?.turn?.id;
          if (tid !== marker.turnId) return;
          if (event.method === 'item/agentMessage/delta' && !marker.warmReady) {
            marker.warmReady = true;
            client.request('turn/interrupt', { threadId: session.threadId, turnId: marker.turnId }).catch(() => {});
          }
          if (event.method === 'turn/completed') { clearTimeout(timer); resolve(); }
        };
        client.on('notification', onNote);
      });
    } catch {
      /* ignore */
    } finally {
      if (onNote) client.off('notification', onNote);
      marker.done = true;
      session.prewarming = false;
    }
  })();
}

async function settlePrewarm(session) {
  const marker = session?._prewarm;
  if (!marker || marker.done) return;
  for (let i = 0; i < 60 && !marker.turnId && !marker.done; i += 1) await delay(50);
  if (marker.turnId && !marker.done) {
    await client.request('turn/interrupt', { threadId: session.threadId, turnId: marker.turnId }).catch(() => {});
  }
  await Promise.race([marker.promise, delay(8000)]).catch(() => {});
}

async function newSession() {
  const r = await client.request('thread/start', { cwd });
  return store.createSession({ thread: r.thread, request: {}, config });
}

async function realTurn(session, text, label) {
  await settlePrewarm(session);
  let firstDeltaAt = null;
  const onNote = (event) => {
    if (event.params?.threadId !== session.threadId) return;
    if (event.method === 'item/agentMessage/delta' && firstDeltaAt === null) firstDeltaAt = performance.now();
  };
  client.on('notification', onNote);
  const startedAt = performance.now();
  const done = new Promise((resolve) => {
    const h = (e) => { if (e.method === 'turn/completed' && e.params?.threadId === session.threadId) { client.off('notification', h); resolve(); } };
    client.on('notification', h);
  });
  await client.request('turn/start', { threadId: session.threadId, input: [{ type: 'text', text }], effort: 'low' });
  await done;
  const ttft = Math.round((firstDeltaAt ?? performance.now()) - startedAt);
  client.off('notification', onNote);
  const s = store.get(session.id);
  console.log(`  [${label}] 首句TTFT=${ttft}ms | 会话内 turns=${s.turns.length} messages=${s.messages.length}`);
  return ttft;
}

(async () => {
  await client.ensureStarted();

  console.log('① 冷基线（不预热，建完立刻发首句）：');
  const a = await newSession();
  await realTurn(a, '用一个词回答：地球的卫星叫什么？', '冷基线');

  console.log('\n② 预热 + 模拟用户读/打字 6s 后再发首句：');
  const b = await newSession();
  prewarmSession(b);
  await delay(6000);
  await realTurn(b, '用一个词回答：法国的首都是？', '预热(有间隔)');

  console.log('\n③ 预热 + 用户立刻就发（最坏情况，应不比冷基线差）：');
  const c = await newSession();
  prewarmSession(c);
  await realTurn(c, '用一个词回答：水的化学式是？', '预热(无间隔)');

  console.log('\n④ 校验零污染：所有会话的 turns 都应只有 1（真实轮），无预热轮残留。');
  for (const [id, s] of store.sessions) {
    const userMsgs = s.messages.filter((m) => m.role === 'user').map((m) => m.text);
    console.log(`  session ${id.slice(0, 8)}: turns=${s.turns.length} 用户消息=${JSON.stringify(userMsgs)}`);
  }

  client.stop();
  process.exit(0);
})().catch((e) => { console.error('probe failed:', e.message); client.stop(); process.exit(1); });
