import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const supportedImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const mimeExtensions = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

export async function createImageUpload({ app, fileName = '', mimeType = '', base64 = '' } = {}) {
  if (!app?.workspaceRoot) {
    const error = new Error('上传图片需要有效 app 工作区');
    error.statusCode = 400;
    throw error;
  }

  const buffer = decodeBase64Image(base64);
  const extension = inferImageExtension({ mimeType, fileName });
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const uploadRoot = path.join(app.workspaceRoot, 'uploads', day);
  await mkdir(uploadRoot, { recursive: true });

  const storedName = `${randomUUID()}${extension}`;
  const target = path.join(uploadRoot, storedName);
  if (!isPathInside(app.workspaceRoot, target)) {
    const error = new Error('上传路径越界');
    error.statusCode = 400;
    throw error;
  }

  await writeFile(target, buffer);
  const normalizedMimeType = normalizeMimeType({ mimeType, extension });
  return {
    fileName: storedName,
    originalName: publicFileNameFromPath(fileName),
    mimeType: normalizedMimeType,
    size: buffer.length,
    path: target,
    input: {
      type: 'localImage',
      path: target,
    },
  };
}

export function decodeBase64Image(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    const error = new Error('缺少图片 base64 内容');
    error.statusCode = 400;
    throw error;
  }
  const clean = raw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  if (!/^[a-z0-9+/=\s]+$/i.test(clean)) {
    const error = new Error('图片 base64 格式无效');
    error.statusCode = 400;
    throw error;
  }
  const buffer = Buffer.from(clean.replace(/\s/g, ''), 'base64');
  if (!buffer.length) {
    const error = new Error('图片内容为空');
    error.statusCode = 400;
    throw error;
  }
  const maxBytes = 12 * 1024 * 1024;
  if (buffer.length > maxBytes) {
    const error = new Error('图片过大，单张不能超过 12MB');
    error.statusCode = 413;
    throw error;
  }
  return buffer;
}

export function inferImageExtension({ mimeType = '', fileName = '' } = {}) {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  if (mimeExtensions.has(normalizedMime)) {
    return mimeExtensions.get(normalizedMime);
  }
  const extension = path.extname(String(fileName || '').trim()).toLowerCase();
  if (supportedImageExtensions.has(extension)) {
    return extension === '.jpeg' ? '.jpg' : extension;
  }
  return '.png';
}

export function normalizeMimeType({ mimeType = '', extension = '' } = {}) {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  if (mimeExtensions.has(normalizedMime)) {
    return normalizedMime === 'image/jpg' ? 'image/jpeg' : normalizedMime;
  }
  return (
    {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.png': 'image/png',
    }[String(extension || '').toLowerCase()] || 'image/png'
  );
}

export function isPathInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function publicFileNameFromPath(filePath) {
  const normalized = String(filePath || '').replaceAll('\\', '/');
  return path.posix.basename(normalized) || 'image';
}

export function resolveUploadAppId({ access = {}, body = {}, headers = {} } = {}) {
  if (access.scope === 'app' && access.appId) {
    return access.appId;
  }
  return String(body.appId || getHeader(headers, 'x-codex-app-id') || '').trim();
}

function getHeader(headers, name) {
  return headers?.[name] || headers?.[name.toLowerCase()] || headers?.[name.toUpperCase()] || '';
}
