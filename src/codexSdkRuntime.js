import { Codex } from '@openai/codex-sdk';

export class CodexSdkRuntime {
  constructor({ codexOptions = {} } = {}) {
    this.codex = new Codex(codexOptions);
  }

  startThread(options = {}) {
    return this.codex.startThread(toSdkThreadOptions(options));
  }

  resumeThread(threadId, options = {}) {
    return this.codex.resumeThread(threadId, toSdkThreadOptions(options));
  }
}

export function createCodexSdkRuntime(options = {}) {
  return new CodexSdkRuntime(options);
}

export function toSdkThreadOptions(options = {}) {
  const out = {
    skipGitRepoCheck: true,
  };
  if (options.cwd) out.workingDirectory = options.cwd;
  if (options.model) out.model = options.model;
  if (options.sandbox) out.sandboxMode = normalizeSandbox(options.sandbox);
  if (options.approvalPolicy) out.approvalPolicy = normalizeApprovalPolicy(options.approvalPolicy);
  if (options.effort) out.modelReasoningEffort = normalizeEffort(options.effort);
  return out;
}

function normalizeSandbox(value) {
  if (value === 'danger-full-access' || value === 'read-only' || value === 'workspace-write') {
    return value;
  }
  return 'workspace-write';
}

function normalizeApprovalPolicy(value) {
  if (value === 'never' || value === 'on-request' || value === 'on-failure' || value === 'untrusted') {
    return value;
  }
  return 'never';
}

function normalizeEffort(value) {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value;
  }
  return 'low';
}
