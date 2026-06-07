import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateApiAccess, normalizeClientIp } from '../src/accessControl.js';

function request({ method = 'GET', path = '/api/health', remoteAddress = '203.0.113.9', headers = {} } = {}) {
  return {
    method,
    url: path,
    headers,
    socket: { remoteAddress },
  };
}

function apps(ids = []) {
  const known = new Set(ids);
  return {
    get(appId) {
      return known.has(appId) ? { appId } : null;
    },
  };
}

const secureConfig = {
  requireAuth: true,
  allowAppIdKeys: true,
  trustProxy: false,
  allowedIps: [],
  adminKeys: [],
};

test('normalizeClientIp handles IPv4 mapped IPv6 addresses', () => {
  assert.equal(normalizeClientIp('::ffff:10.10.0.142'), '10.10.0.142');
});

test('loopback clients are allowed as admin even when auth is required', () => {
  const result = evaluateApiAccess({
    req: request({ remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4555' } }),
    security: secureConfig,
    apps: apps(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.scope, 'admin');
});

test('loopback clients using a public host still need an access key', () => {
  const result = evaluateApiAccess({
    req: request({ remoteAddress: '127.0.0.1', headers: { host: 'public-bridge.example.com' } }),
    security: secureConfig,
    apps: apps(),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 401);
});

test('remote clients are rejected when no whitelist or key matches', () => {
  const result = evaluateApiAccess({
    req: request(),
    security: secureConfig,
    apps: apps(['known-app']),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 401);
});

test('CIDR whitelist allows remote clients as admin', () => {
  const result = evaluateApiAccess({
    req: request({ remoteAddress: '10.10.3.22' }),
    security: { ...secureConfig, allowedIps: ['10.10.0.0/21'] },
    apps: apps(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.scope, 'admin');
});

test('registered appId bearer token allows app scoped session API', () => {
  const result = evaluateApiAccess({
    req: request({
      method: 'POST',
      path: '/api/sessions',
      headers: { authorization: 'Bearer app-123' },
    }),
    security: secureConfig,
    apps: apps(['app-123']),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.scope, 'app');
  assert.equal(result.appId, 'app-123');
});

test('registered appId bearer token allows app scoped image uploads', () => {
  const result = evaluateApiAccess({
    req: request({
      method: 'POST',
      path: '/api/uploads/images',
      headers: { authorization: 'Bearer app-123' },
    }),
    security: secureConfig,
    apps: apps(['app-123']),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.scope, 'app');
  assert.equal(result.appId, 'app-123');
});

test('registered appId bearer token allows mobile runtime APIs', () => {
  for (const [method, path] of [
    ['GET', '/api/status'],
    ['GET', '/api/config'],
    ['GET', '/api/account'],
    ['GET', '/api/rate-limits'],
    ['POST', '/api/codex/start'],
    ['POST', '/api/codex/restart'],
  ]) {
    const result = evaluateApiAccess({
      req: request({
        method,
        path,
        headers: { authorization: 'Bearer app-123' },
      }),
      security: secureConfig,
      apps: apps(['app-123']),
    });

    assert.equal(result.allowed, true, `${method} ${path}`);
    assert.equal(result.scope, 'app', `${method} ${path}`);
    assert.equal(result.appId, 'app-123', `${method} ${path}`);
  }
});

test('app scoped key cannot create new appIds', () => {
  const result = evaluateApiAccess({
    req: request({
      method: 'POST',
      path: '/api/apps',
      headers: { 'x-codex-bridge-key': 'app-123' },
    }),
    security: secureConfig,
    apps: apps(['app-123']),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 403);
});

test('app scoped key cannot write global config', () => {
  const result = evaluateApiAccess({
    req: request({
      method: 'PUT',
      path: '/api/config',
      headers: { authorization: 'Bearer app-123' },
    }),
    security: secureConfig,
    apps: apps(['app-123']),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 403);
});

test('admin key allows all API routes', () => {
  const result = evaluateApiAccess({
    req: request({
      method: 'POST',
      path: '/api/apps',
      headers: { 'x-codex-bridge-key': 'root-secret' },
    }),
    security: { ...secureConfig, adminKeys: ['root-secret'] },
    apps: apps(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.scope, 'admin');
});
