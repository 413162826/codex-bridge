import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createImageUpload,
  inferImageExtension,
  isPathInside,
  publicFileNameFromPath,
  resolveUploadAppId,
} from '../src/fileGateway.js';

test('inferImageExtension keeps supported image types predictable', () => {
  assert.equal(inferImageExtension({ mimeType: 'image/png', fileName: 'photo.weird' }), '.png');
  assert.equal(inferImageExtension({ mimeType: 'image/jpeg', fileName: 'photo.bin' }), '.jpg');
  assert.equal(inferImageExtension({ mimeType: '', fileName: 'scan.webp' }), '.webp');
  assert.equal(inferImageExtension({ mimeType: 'application/octet-stream', fileName: 'scan.txt' }), '.png');
});

test('isPathInside rejects sibling paths that only share a prefix', () => {
  const root = path.resolve(os.tmpdir(), 'bridge-app');
  assert.equal(isPathInside(root, path.join(root, 'uploads', 'a.png')), true);
  assert.equal(isPathInside(root, `${root}-other`, 'a.png'), false);
});

test('publicFileNameFromPath returns a stable display name', () => {
  assert.equal(publicFileNameFromPath('D:\\tmp\\hello world.png'), 'hello world.png');
});

test('createImageUpload writes base64 data under the app workspace and returns a localImage input', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-bridge-app-'));
  try {
    const result = await createImageUpload({
      app: { appId: 'app-123', workspaceRoot },
      fileName: 'sample.jpg',
      mimeType: 'image/jpeg',
      base64: Buffer.from('image-bytes').toString('base64'),
    });

    assert.equal(result.input.type, 'localImage');
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.fileName.endsWith('.jpg'), true);
    assert.equal(isPathInside(workspaceRoot, result.path), true);
    assert.equal(await readFile(result.path, 'utf8'), 'image-bytes');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('resolveUploadAppId prefers app scope but supports admin x-codex-app-id header', () => {
  assert.equal(resolveUploadAppId({ access: { scope: 'app', appId: 'app-scope' }, body: { appId: 'body-app' } }), 'app-scope');
  assert.equal(resolveUploadAppId({ access: { scope: 'admin' }, body: { appId: 'body-app' } }), 'body-app');
  assert.equal(resolveUploadAppId({ access: { scope: 'admin' }, headers: { 'x-codex-app-id': 'header-app' } }), 'header-app');
});
