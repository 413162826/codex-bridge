import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeStaticPathname } from '../src/staticPaths.js';

test('static paths map legacy mobile htm URL to the PWA entry', () => {
  assert.equal(normalizeStaticPathname('/m/index.htm', '/index.html'), '/m/index.html');
});

test('static paths keep public remote root on mobile entry', () => {
  assert.equal(normalizeStaticPathname('/', '/m/index.html'), '/m/index.html');
});
