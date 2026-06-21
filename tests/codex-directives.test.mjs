import assert from 'node:assert/strict';
import test from 'node:test';

import { createHiddenCodexDirectiveStreamFilter, stripHiddenCodexDirectives } from '../src/codexDirectives.js';

test('stripHiddenCodexDirectives removes visible inbox directives', () => {
  const input = [
    '你好，请说要处理什么。',
    '',
    '::inbox-item{title="等待用户任务" summary="用户仅打招呼，尚未提供具体需求"}',
  ].join('\n');

  assert.equal(stripHiddenCodexDirectives(input).text, '你好，请说要处理什么。');
});

test('stripHiddenCodexDirectives keeps inline directive-looking text', () => {
  const input = '解释一下 ::inbox-item{title="示例"} 是什么。';

  assert.equal(stripHiddenCodexDirectives(input).text, input);
});

test('hidden directive stream filter suppresses split inbox directives', () => {
  const filter = createHiddenCodexDirectiveStreamFilter();
  const chunks = [
    '你好，请说要处理什么。\n\n::in',
    'box-item{title="等待用户任务" summary="用户仅打招呼，尚未提供具体需求"}',
  ];

  const output = chunks.map((chunk) => filter.push(chunk)).join('') + filter.flush();

  assert.equal(output, '你好，请说要处理什么。');
});
