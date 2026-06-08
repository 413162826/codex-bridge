// 量化“每个新线程要重新处理的静态前缀”有多大：发一个极小轮，读它的输入 token 数。
// 输入 token ≈ 静态前缀(AGENTS/记忆/技能/环境) + 这句极短问题，可近似当作前缀规模。
import { CodexAppServerClient } from '../src/codexAppServerClient.js';

const cwd = process.argv[2] || process.cwd();
const client = new CodexAppServerClient({ cwd });

(async () => {
  await client.ensureStarted();
  const t = (await client.request('thread/start', { cwd })).thread.id;

  let usage = null;
  client.on('notification', (e) => {
    if (e.params?.threadId !== t) return;
    if (e.method === 'thread/tokenUsage/updated') usage = e.params.tokenUsage ?? e.params.usage ?? e.params;
  });

  const done = new Promise((resolve) => {
    const h = (e) => { if (e.method === 'turn/completed' && e.params?.threadId === t) { client.off('notification', h); resolve(); } };
    client.on('notification', h);
  });
  await client.request('turn/start', { threadId: t, input: [{ type: 'text', text: '回复一个字：好' }], effort: 'low' });
  await done;

  console.log('一个全新线程、极短首轮的 tokenUsage：');
  console.log(JSON.stringify(usage, null, 2));

  client.stop();
  process.exit(0);
})().catch((e) => { console.error('probe failed:', e.message); client.stop(); process.exit(1); });
