import { stripHiddenCodexDirectives } from './codexDirectives.js';

const MAX_TRANSCRIPT_MESSAGES = 300;
const MAX_MESSAGE_CHARS = 8000;
const PREWARM_MARKER = '系统预热';

export function bridgeSessionMessages(session) {
  const storedMessages = messagesFromStoredSession(session?.messages);
  if (storedMessages.length > 0) return storedMessages;
  return messagesFromThreadTurns(session?.thread?.turns);
}

function messagesFromStoredSession(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .map((message) => ({
      role: message.role,
      text: cleanAssistantText(message.text || ''),
      status: message.status || 'done',
      at: message.updatedAt || message.createdAt || null,
    }))
    .filter((message) => message.text && !isPrewarm(message.text));
}

function messagesFromThreadTurns(turns) {
  if (!Array.isArray(turns)) return [];
  const messages = [];
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      const message = messageFromThreadItem(item, turn);
      if (message) messages.push(message);
    }
  }
  return messages.slice(-MAX_TRANSCRIPT_MESSAGES);
}

function messageFromThreadItem(item, turn) {
  if (item?.type === 'userMessage') {
    const raw = textFromContent(item.content) || item.text || item.message || '';
    const text = cleanUserText(raw);
    if (!text || isPrewarm(text)) return null;
    return {
      role: 'user',
      text,
      status: 'done',
      at: item.createdAt || turn?.startedAt || null,
    };
  }

  if (item?.type === 'agentMessage') {
    const text = cleanAssistantText(item.text || item.message || '');
    if (!text) return null;
    return {
      role: 'assistant',
      text,
      status: turn?.status === 'interrupted' ? 'interrupted' : 'done',
      at: item.updatedAt || item.createdAt || turn?.completedAt || turn?.startedAt || null,
    };
  }

  return null;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => textFromContentPart(part))
    .filter(Boolean)
    .join('\n');
}

function textFromContentPart(part) {
  if (typeof part === 'string') return part.trim();
  if (!part || typeof part !== 'object') return '';
  if (part.type === 'text' || part.type === 'input_text') return String(part.text || '').trim();
  if (part.type === 'localImage') return part.path ? `[图片] ${part.path}` : '[图片]';
  if (part.type === 'localFile') return part.path ? `[文件] ${part.path}` : '[文件]';
  if (typeof part.text === 'string') return part.text.trim();
  if (typeof part.path === 'string') return `[附件] ${part.path}`;
  if (typeof part.url === 'string') return `[链接] ${part.url}`;
  return '';
}

function cleanUserText(value) {
  return String(value || '').trim().slice(0, MAX_MESSAGE_CHARS);
}

function cleanAssistantText(value) {
  return stripHiddenCodexDirectives(value || '').text.trim().slice(0, MAX_MESSAGE_CHARS);
}

function isPrewarm(text) {
  return String(text || '').includes(PREWARM_MARKER);
}
