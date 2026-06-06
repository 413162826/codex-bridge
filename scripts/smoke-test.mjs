const baseUrl = process.env.CODEX_BRIDGE_URL || 'http://127.0.0.1:4555';

async function main() {
  const health = await request('/api/health');
  console.log('health:', health.ok, health.codex.started ? 'codex-started' : 'codex-idle');

  await request('/api/codex/start', { method: 'POST' });
  const sessionResult = await request('/api/sessions', {
    method: 'POST',
    body: {
      name: 'smoke-test',
      ephemeral: true,
      initialPrompt: 'smoke',
    },
  });
  console.log('session:', sessionResult.session.id);

  const turnResult = await request(`/api/sessions/${sessionResult.session.id}/turns?wait=1`, {
    method: 'POST',
    body: {
      text: '只回复 BRIDGE-OK',
      effort: 'low',
    },
  });
  const assistant = turnResult.session.messages.filter((item) => item.role === 'assistant').at(-1);
  console.log('assistant:', assistant?.text?.trim());
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message || `${res.status} ${res.statusText}`);
  }
  return json;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
