import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeSessionMessages } from '../src/mobileSessionView.js';

test('bridgeSessionMessages 优先使用新格式 messages', () => {
  const messages = bridgeSessionMessages({
    messages: [
      { role: 'system', text: 'hidden' },
      { role: 'user', text: '你好', createdAt: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: '收到\n::inbox-item{"id":"x"}', updatedAt: '2026-01-01T00:00:01.000Z' },
    ],
    thread: {
      turns: [
        {
          items: [{ type: 'userMessage', content: [{ type: 'text', text: '旧内容' }] }],
        },
      ],
    },
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, '你好');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].text, '收到');
});

test('bridgeSessionMessages 兼容 messages 为空的旧 thread.turns 会话', () => {
  const messages = bridgeSessionMessages({
    messages: [],
    thread: {
      turns: [
        {
          startedAt: '2026-01-01T10:00:00.000Z',
          completedAt: '2026-01-01T10:00:01.000Z',
          items: [
            {
              type: 'userMessage',
              content: [
                { type: 'text', text: '帮我看看这个截图' },
                { type: 'localImage', path: 'C:\\tmp\\a.png' },
              ],
            },
            {
              type: 'agentMessage',
              text: '我先看下结构。',
              phase: 'commentary',
            },
          ],
        },
      ],
    },
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, '帮我看看这个截图\n[图片] C:\\tmp\\a.png');
  assert.equal(messages[0].at, '2026-01-01T10:00:00.000Z');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].text, '我先看下结构。');
  assert.equal(messages[1].at, '2026-01-01T10:00:01.000Z');
});

test('bridgeSessionMessages 跳过预热消息和空文本 item', () => {
  const messages = bridgeSessionMessages({
    messages: [],
    thread: {
      turns: [
        {
          startedAt: '2026-01-01T10:00:00.000Z',
          items: [
            { type: 'userMessage', content: [{ type: 'text', text: '（系统预热，无需理会）' }] },
            { type: 'agentMessage', text: '' },
            { type: 'userMessage', content: [{ type: 'text', text: '真实问题' }] },
          ],
        },
      ],
    },
  });

  assert.deepEqual(messages.map((message) => message.text), ['真实问题']);
});
