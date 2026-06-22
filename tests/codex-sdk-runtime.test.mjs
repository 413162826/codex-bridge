import test from 'node:test';
import assert from 'node:assert/strict';

import { toSdkThreadOptions } from '../src/codexSdkRuntime.js';

test('toSdkThreadOptions maps execution profile sandboxPolicy to SDK sandboxMode', () => {
  const options = toSdkThreadOptions({
    cwd: 'D:\\repo',
    sandboxPolicy: { type: 'dangerFullAccess' },
    approvalPolicy: 'never',
    effort: 'xhigh',
    additionalDirectories: ['D:\\repo-extra'],
  });

  assert.equal(options.workingDirectory, 'D:\\repo');
  assert.equal(options.sandboxMode, 'danger-full-access');
  assert.equal(options.approvalPolicy, 'never');
  assert.equal(options.modelReasoningEffort, 'xhigh');
  assert.deepEqual(options.additionalDirectories, ['D:\\repo-extra']);
});

test('toSdkThreadOptions rejects unknown sandbox and approval policy instead of falling back', () => {
  assert.throws(() => toSdkThreadOptions({ sandboxPolicy: { type: 'mystery' } }), /不支持的 sandbox/);
  assert.throws(() => toSdkThreadOptions({ approvalPolicy: 'always' }), /不支持的 approvalPolicy/);
});
