import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStateLenient } from '../src/stateStore.js';

test('parseStateLenient parses healthy JSON', () => {
  const parsed = parseStateLenient(JSON.stringify({ sessions: [{ id: 'a' }], apps: [] }));
  assert.equal(parsed.sessions.length, 1);
});

test('parseStateLenient salvages valid-JSON-then-trailing-garbage corruption', () => {
  // 模拟旧版并发写盘 bug 写出的文件：完整 JSON 后面跟一段残留尾巴。
  const good = JSON.stringify({ sessions: [{ id: 'a' }, { id: 'b' }], apps: [] }, null, 2);
  const corrupt = `${good}\n}  ],`;
  const parsed = parseStateLenient(corrupt);
  assert.ok(parsed, 'should salvage a parseable prefix');
  assert.equal(parsed.sessions.length, 2);
});

test('parseStateLenient returns null when nothing is salvageable', () => {
  assert.equal(parseStateLenient('not json at all }{'), null);
});
