import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export async function materializeMobileAttachments({ attachments = [], root, now = new Date() } = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }
  if (!root) {
    const error = new Error('上传附件需要有效存储目录');
    error.statusCode = 400;
    throw error;
  }

  const day = now.toISOString().slice(0, 10);
  const uploadRoot = path.join(root, 'mobile-uploads', day);
  await mkdir(uploadRoot, { recursive: true });

  const files = [];
  for (const attachment of attachments.slice(0, 8)) {
    const buffer = decodeBase64Payload(attachment.data || attachment.base64 || attachment.dataUrl || '');
    const originalName = publicFileName(attachment.name || attachment.fileName || 'attachment');
    const extension = inferExtension({ fileName: originalName, mimeType: attachment.mimeType });
    const storedName = `${randomUUID()}${extension}`;
    const target = path.join(uploadRoot, storedName);
    await writeFile(target, buffer);
    files.push({
      name: storedName,
      originalName,
      path: target,
      mimeType: normalizeMimeType({ mimeType: attachment.mimeType, extension }),
      size: buffer.length,
      kind: isImage({ mimeType: attachment.mimeType, fileName: originalName }) ? 'image' : 'file',
    });
  }
  return files;
}

export function buildMobileCodexInput({ text = '', files = [], imageMode = false } = {}) {
  const promptText = imageMode ? buildImagePrompt(text) : String(text || '').trim();
  const fileNotes = files
    .filter((file) => file.kind !== 'image')
    .map((file) => `- ${file.originalName}: ${file.path}`)
    .join('\n');
  const parts = [promptText || '请查看我上传的内容。'];
  if (fileNotes) {
    parts.push(`用户上传了这些文件，路径如下。需要读取时请直接打开对应路径：\n${fileNotes}`);
  }

  const input = [{ type: 'text', text: parts.join('\n\n') }];
  for (const file of files) {
    if (file.kind === 'image') {
      input.push({ type: 'local_image', path: file.path });
    }
  }
  return input;
}

export function toAppServerInput(input = []) {
  return input.map((item) => {
    if (item.type === 'text') {
      return { type: 'text', text: item.text, text_elements: [] };
    }
    if (item.type === 'local_image') {
      return { type: 'localImage', path: item.path };
    }
    return item;
  });
}

export function attachmentSummary(files = []) {
  return files.map((file) => ({
    name: file.originalName,
    path: file.path,
    mimeType: file.mimeType,
    size: file.size,
    kind: file.kind,
  }));
}

function buildImagePrompt(text) {
  return [
    `$imagegen ${String(text || '').trim()}`,
    '',
    '请直接生成这张图片，并保存为 PNG 到当前工作目录下的 codex-output/images/ 文件夹（文件名用英文），最后在回复里给出保存的相对路径。',
  ].join('\n');
}

function decodeBase64Payload(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    const error = new Error('附件内容为空');
    error.statusCode = 400;
    throw error;
  }
  const clean = raw.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
  if (!/^[a-z0-9+/=]+$/i.test(clean)) {
    const error = new Error('附件 base64 格式无效');
    error.statusCode = 400;
    throw error;
  }
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer.length) {
    const error = new Error('附件内容为空');
    error.statusCode = 400;
    throw error;
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    const error = new Error('附件过大，单个文件不能超过 20MB');
    error.statusCode = 413;
    throw error;
  }
  return buffer;
}

function inferExtension({ fileName = '', mimeType = '' } = {}) {
  const fromName = path.extname(String(fileName || '')).toLowerCase();
  if (fromName && /^[.][a-z0-9]{1,12}$/.test(fromName)) {
    return fromName === '.jpeg' ? '.jpg' : fromName;
  }
  const normalized = String(mimeType || '').toLowerCase();
  return (
    {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'application/pdf': '.pdf',
      'text/plain': '.txt',
      'text/markdown': '.md',
      'application/json': '.json',
    }[normalized] || '.bin'
  );
}

function normalizeMimeType({ mimeType = '', extension = '' } = {}) {
  const normalized = String(mimeType || '').trim().toLowerCase();
  if (normalized) {
    return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  }
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
    }[extension] || 'application/octet-stream'
  );
}

function isImage({ mimeType = '', fileName = '' } = {}) {
  return String(mimeType || '').toLowerCase().startsWith('image/') || imageExtensions.has(path.extname(fileName).toLowerCase());
}

function publicFileName(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  return path.posix.basename(normalized) || 'attachment';
}
