export function threadExecutionParams(profile = {}) {
  const params = {};
  if (profile.cwd) {
    params.cwd = profile.cwd;
  }
  return {
    ...params,
    ...executionPermissionParams(profile, 'thread'),
  };
}

export function turnExecutionParams(profile = {}) {
  return executionPermissionParams(profile, 'turn');
}

export function sandboxModeFromPolicy(policy) {
  if (typeof policy === 'string') {
    return normalizeSandboxMode(policy);
  }
  return normalizeSandboxMode(policy?.type);
}

export function sandboxPolicyFromMode(mode) {
  switch (normalizeSandboxMode(mode)) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false };
    case 'workspace-write':
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: [],
        readOnlyAccess: { type: 'fullAccess' },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

function executionPermissionParams(profile, target) {
  const permissionProfile = usablePermissionProfile(profile.permissionProfile);
  if (permissionProfile) {
    return { permissionProfile };
  }

  if (target === 'thread') {
    const sandbox = sandboxModeFromPolicy(profile.sandboxPolicy);
    return sandbox ? { sandbox } : {};
  }

  const sandboxPolicy = usableSandboxPolicy(profile.sandboxPolicy);
  return sandboxPolicy ? { sandboxPolicy } : {};
}

function usablePermissionProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  switch (profile.type) {
    case 'disabled':
      return profile;
    case 'managed':
      return profile.network && profile.fileSystem ? profile : null;
    case 'external':
      return profile.network ? profile : null;
    default:
      return null;
  }
}

function usableSandboxPolicy(policy) {
  if (!policy) return null;
  if (typeof policy === 'string') {
    const mode = sandboxModeFromPolicy(policy);
    return mode ? sandboxPolicyFromMode(mode) : null;
  }
  if (typeof policy !== 'object') return null;

  switch (policy.type) {
    case 'dangerFullAccess':
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'readOnly':
    case 'read-only':
      if (!policy.access && !policy.readOnlyAccess) return null;
      return {
        type: 'readOnly',
        access: policy.access || policy.readOnlyAccess,
        networkAccess: Boolean(policy.networkAccess ?? policy.network_access),
      };
    case 'externalSandbox':
      if (!policy.networkAccess && !policy.network_access) return null;
      return {
        type: 'externalSandbox',
        networkAccess: policy.networkAccess ?? policy.network_access,
      };
    case 'workspaceWrite':
    case 'workspace-write': {
      const writableRoots = policy.writableRoots || policy.writable_roots;
      const readOnlyAccess = policy.readOnlyAccess || policy.read_only_access;
      if (!Array.isArray(writableRoots) || !readOnlyAccess) return null;
      return {
        type: 'workspaceWrite',
        writableRoots,
        readOnlyAccess,
        networkAccess: Boolean(policy.networkAccess ?? policy.network_access),
        excludeTmpdirEnvVar: Boolean(policy.excludeTmpdirEnvVar ?? policy.exclude_tmpdir_env_var),
        excludeSlashTmp: Boolean(policy.excludeSlashTmp ?? policy.exclude_slash_tmp),
      };
    }
    default:
      return null;
  }
}

function normalizeSandboxMode(value) {
  switch (String(value || '').trim()) {
    case 'danger-full-access':
    case 'dangerFullAccess':
      return 'danger-full-access';
    case 'workspace-write':
    case 'workspaceWrite':
      return 'workspace-write';
    case 'read-only':
    case 'readOnly':
      return 'read-only';
    default:
      return '';
  }
}
