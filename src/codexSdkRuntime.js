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

  run(input, options = {}, turnOptions = {}) {
    return this.startThread(options).run(input, turnOptions);
  }

  runStreamed(input, options = {}, turnOptions = {}) {
    return this.startThread(options).runStreamed(input, turnOptions);
  }
}

export function createCodexSdkRuntime(options = {}) {
  return new CodexSdkRuntime(options);
}

export function toSdkThreadOptions(options = {}) {
  const out = {
    skipGitRepoCheck: true,
  };
  if (options.cwd || options.workingDirectory) out.workingDirectory = options.cwd || options.workingDirectory;
  if (options.model) out.model = options.model;
  if (options.sandboxPolicy || options.sandbox) out.sandboxMode = normalizeSandbox(options.sandboxPolicy || options.sandbox);
  if (options.approvalPolicy) out.approvalPolicy = normalizeApprovalPolicy(options.approvalPolicy);
  if (options.effort) out.modelReasoningEffort = normalizeEffort(options.effort);
  if (Array.isArray(options.additionalDirectories)) out.additionalDirectories = options.additionalDirectories;
  return out;
}

function normalizeSandbox(value) {
  const mode = sandboxModeFromPolicy(value);
  if (mode) {
    return mode;
  }
  throw new Error(`不支持的 sandbox：${JSON.stringify(value)}`);
}

function normalizeApprovalPolicy(value) {
  if (value === 'never' || value === 'on-request' || value === 'on-failure' || value === 'untrusted') {
    return value;
  }
  throw new Error(`不支持的 approvalPolicy：${value}`);
}

function normalizeEffort(value) {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value;
  }
  throw new Error(`不支持的 effort：${value}`);
}

function sandboxModeFromPolicy(value) {
  if (value === 'danger-full-access' || value === 'read-only' || value === 'workspace-write') {
    return value;
  }
  switch (value?.type) {
    case 'dangerFullAccess':
      return 'danger-full-access';
    case 'workspaceWrite':
      return 'workspace-write';
    case 'readOnly':
      return 'read-only';
    default:
      return '';
  }
}
