import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sandboxModeFromPolicy,
  sandboxPolicyFromMode,
  threadExecutionParams,
  turnExecutionParams,
} from '../src/appServerProtocol.js';

test('thread params use permissionProfile as the canonical permission override', () => {
  const profile = {
    cwd: 'D:\\repo',
    sandboxPolicy: { type: 'dangerFullAccess' },
    permissionProfile: { type: 'disabled' },
  };

  assert.deepEqual(threadExecutionParams(profile), {
    cwd: 'D:\\repo',
    permissionProfile: { type: 'disabled' },
  });
  assert.deepEqual(turnExecutionParams(profile), {
    permissionProfile: { type: 'disabled' },
  });
});

test('thread params convert sandboxPolicy to app-server sandbox mode when permissionProfile is absent', () => {
  assert.deepEqual(
    threadExecutionParams({
      cwd: 'D:\\repo',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }),
    {
      cwd: 'D:\\repo',
      sandbox: 'danger-full-access',
    },
  );
});

test('incomplete bridge default permissionProfile falls back to sandbox mode', () => {
  assert.deepEqual(
    threadExecutionParams({
      cwd: 'D:\\repo',
      sandboxPolicy: { type: 'workspaceWrite' },
      permissionProfile: { type: 'managed' },
    }),
    {
      cwd: 'D:\\repo',
      sandbox: 'workspace-write',
    },
  );
});

test('turn params only send a schema-valid sandboxPolicy fallback', () => {
  assert.deepEqual(turnExecutionParams({ sandboxPolicy: { type: 'danger-full-access' } }), {
    sandboxPolicy: { type: 'dangerFullAccess' },
  });
  assert.deepEqual(turnExecutionParams({ sandboxPolicy: { type: 'workspaceWrite' } }), {});
});

test('sandbox helpers map between app-server mode strings and policy objects', () => {
  assert.equal(sandboxModeFromPolicy({ type: 'readOnly' }), 'read-only');
  assert.deepEqual(sandboxPolicyFromMode('read-only'), {
    type: 'readOnly',
    access: { type: 'fullAccess' },
    networkAccess: false,
  });
});
