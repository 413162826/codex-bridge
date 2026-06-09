import test from 'node:test';
import assert from 'node:assert/strict';

import { tryParseJson, sliceJsonLike, toStrictJsonSchema } from '../src/complete.js';

test('tryParseJson 解析干净的对象/数组', () => {
  assert.deepEqual(tryParseJson('{"a":1,"b":"x"}'), { ok: true, value: { a: 1, b: 'x' } });
  assert.deepEqual(tryParseJson('  [1, 2, 3]  '), { ok: true, value: [1, 2, 3] });
});

test('tryParseJson 剥掉 ```json 围栏', () => {
  const text = '```json\n{"title":"复盘页"}\n```';
  assert.deepEqual(tryParseJson(text), { ok: true, value: { title: '复盘页' } });
});

test('tryParseJson 剥掉无语言标记的围栏', () => {
  const text = '```\n{"ok":true}\n```';
  assert.deepEqual(tryParseJson(text), { ok: true, value: { ok: true } });
});

test('tryParseJson 截掉 JSON 前后的解释性文字', () => {
  const text = '好的，结果如下：\n{"items":[{"q":"图片重复"}]}\n以上。';
  assert.deepEqual(tryParseJson(text), { ok: true, value: { items: [{ q: '图片重复' }] } });
});

test('tryParseJson 对空响应和非 JSON 返回 ok:false', () => {
  assert.equal(tryParseJson('').ok, false);
  assert.equal(tryParseJson('   ').ok, false);
  assert.equal(tryParseJson('这是一段没有任何结构的纯文本').ok, false);
});

test('toStrictJsonSchema 给对象补 additionalProperties:false 且 required 列全字段', () => {
  const strict = toStrictJsonSchema({
    type: 'object',
    properties: { title: { type: 'string' }, count: { type: 'number' } },
    required: ['title'],
  });
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ['title', 'count']);
});

test('toStrictJsonSchema 递归处理嵌套对象与数组项', () => {
  const strict = toStrictJsonSchema({
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: { type: 'object', properties: { text: { type: 'string' } } },
      },
      meta: { type: 'object', properties: { day: { type: 'string' } } },
    },
  });
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ['todos', 'meta']);
  assert.equal(strict.properties.todos.items.additionalProperties, false);
  assert.deepEqual(strict.properties.todos.items.required, ['text']);
  assert.equal(strict.properties.meta.additionalProperties, false);
});

test('toStrictJsonSchema 不改入参（纯函数）', () => {
  const input = { type: 'object', properties: { a: { type: 'string' } } };
  const snapshot = JSON.parse(JSON.stringify(input));
  toStrictJsonSchema(input);
  assert.deepEqual(input, snapshot);
});

test('toStrictJsonSchema 处理 type 为数组(可空对象)', () => {
  const strict = toStrictJsonSchema({
    type: ['object', 'null'],
    properties: { a: { type: 'string' } },
  });
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ['a']);
});

test('sliceJsonLike 取首个 { 或 [ 到对应收尾符', () => {
  assert.equal(sliceJsonLike('前缀 {"a":1} 后缀'), '{"a":1}');
  assert.equal(sliceJsonLike('x [1,2] y'), '[1,2]');
  // 收尾符按“第一个开括号”的类型选取：首个是 {，故取到最后一个 }。
  assert.equal(sliceJsonLike('text {"a":1} more [9]'), '{"a":1}');
  assert.equal(sliceJsonLike('没有大括号'), null);
});
