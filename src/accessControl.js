const bearerPrefix = 'bearer ';

export function createSecurityConfig(env = process.env, base = {}) {
  const allowedIps = pickList(env.CODEX_BRIDGE_ALLOWED_IPS, base.allowedIps);
  const adminKeys = pickList(env.CODEX_BRIDGE_ADMIN_KEYS || env.CODEX_BRIDGE_API_KEYS, base.adminKeys);
  const requireAuth = resolveRequireAuth(env.CODEX_BRIDGE_REQUIRE_AUTH, base.requireAuth, allowedIps, adminKeys);

  return {
    requireAuth,
    allowedIps,
    adminKeys,
    allowAppIdKeys: env.CODEX_BRIDGE_ALLOW_APP_KEYS === '0' ? false : base.allowAppIdKeys !== false,
    trustProxy: env.CODEX_BRIDGE_TRUST_PROXY === '1' ? true : Boolean(base.trustProxy),
  };
}

function resolveRequireAuth(envValue, baseValue, allowedIps, adminKeys) {
  // 环境变量是显式开关；其次看配置文件写死的值；最后回退到"配了白名单/admin key 就视为要鉴权"。
  if (envValue === '1') return true;
  if (envValue === '0') return false;
  if (baseValue === true) return true;
  if (baseValue === false) return false;
  return allowedIps.length > 0 || adminKeys.length > 0;
}

function pickList(envValue, baseValue) {
  const fromEnv = splitList(envValue);
  if (fromEnv.length) return fromEnv;
  if (Array.isArray(baseValue)) {
    return baseValue.map((item) => String(item).trim()).filter(Boolean);
  }
  return splitList(baseValue);
}

export function publicSecurityConfig(security = {}) {
  return {
    requireAuth: Boolean(security.requireAuth),
    allowAppIdKeys: security.allowAppIdKeys !== false,
    trustProxy: Boolean(security.trustProxy),
    allowedIps: security.allowedIps || [],
    adminKeysConfigured: Array.isArray(security.adminKeys) ? security.adminKeys.length : 0,
  };
}

export function evaluateApiAccess({ req, security, apps }) {
  const clientIp = getClientIp(req, security);
  if (!security?.requireAuth) {
    return allow('admin', { reason: 'auth-disabled', clientIp });
  }

  if (isDirectLoopback(req, clientIp)) {
    return allow('admin', { reason: 'loopback', clientIp });
  }

  if (isIpAllowed(clientIp, security.allowedIps || [])) {
    return allow('admin', { reason: 'ip-whitelist', clientIp });
  }

  const accessKey = extractAccessKey(req);
  if (!accessKey) {
    return deny(401, '缺少访问密钥或来源 IP 不在白名单中', clientIp);
  }

  if ((security.adminKeys || []).includes(accessKey)) {
    return allow('admin', { reason: 'admin-key', clientIp });
  }

  const app = security.allowAppIdKeys === false ? null : apps.get(accessKey);
  if (!app) {
    return deny(401, '访问密钥无效，且来源 IP 不在白名单中', clientIp);
  }

  const url = new URL(req.url, 'http://codex-bridge.local');
  if (!isAppRouteAllowed(req.method, url.pathname, app.appId)) {
    return deny(403, '当前 appId 无权访问该 API', clientIp, app.appId);
  }

  return allow('app', { reason: 'app-key', clientIp, appId: app.appId });
}

export function normalizeClientIp(value = '') {
  const raw = String(value || '').trim();
  if (raw.startsWith('::ffff:')) {
    return raw.slice('::ffff:'.length);
  }
  if (raw === '::1') {
    return '127.0.0.1';
  }
  return raw;
}

function getClientIp(req, security = {}) {
  if (security.trustProxy) {
    const forwarded = getHeader(req, 'x-forwarded-for');
    if (forwarded) {
      return normalizeClientIp(forwarded.split(',')[0]);
    }
    const realIp = getHeader(req, 'x-real-ip');
    if (realIp) {
      return normalizeClientIp(realIp);
    }
  }
  return normalizeClientIp(req.socket?.remoteAddress || '');
}

function extractAccessKey(req) {
  const authorization = getHeader(req, 'authorization');
  if (authorization.toLowerCase().startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length).trim();
  }

  const headerKey = getHeader(req, 'x-codex-bridge-key') || getHeader(req, 'x-codex-app-id');
  if (headerKey) {
    return headerKey.trim();
  }

  const url = new URL(req.url, 'http://codex-bridge.local');
  return (url.searchParams.get('accessKey') || url.searchParams.get('appId') || '').trim();
}

function getHeader(req, name) {
  return req.headers?.[name] || req.headers?.[name.toLowerCase()] || req.headers?.[name.toUpperCase()] || '';
}

function isAppRouteAllowed(method, pathname, appId) {
  const route = `${method} ${pathname}`;
  if (
    route === 'GET /api/health' ||
    route === 'GET /api/status' ||
    route === 'GET /api/config' ||
    route === 'GET /api/models' ||
    route === 'GET /api/account' ||
    route === 'GET /api/rate-limits' ||
    route === 'GET /api/openapi.json'
  ) {
    return true;
  }

  if (route === 'POST /api/codex/start' || route === 'POST /api/codex/restart') {
    return true;
  }

  if (route === 'POST /api/uploads/images') {
    return true;
  }

  if (route === `GET /api/apps/${appId}`) {
    return true;
  }

  if (route === 'GET /api/sessions' || route === 'POST /api/sessions') {
    return true;
  }

  const sessionRoute = pathname.match(/^\/api\/sessions\/[^/]+(?:\/([^/]+))?$/);
  if (!sessionRoute) {
    return false;
  }

  const action = sessionRoute[1] || '';
  if (method === 'GET' && (!action || action === 'events' || action === 'files')) {
    return true;
  }
  if (method === 'POST' && ['resume', 'turns', 'interrupt', 'steer', 'archive'].includes(action)) {
    return true;
  }
  return false;
}

function isDirectLoopback(req, clientIp) {
  if (!isLoopbackIp(clientIp) || !isLocalHostHeader(getHeader(req, 'host'))) {
    return false;
  }
  // 经过 ngrok / 反向代理隧道转发的请求即使从回环地址进来，也会带转发头；
  // 这类请求不能享受本机管理员待遇，必须回到访问密钥校验。
  return !getHeader(req, 'x-forwarded-for') && !getHeader(req, 'x-real-ip');
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

function isLocalHostHeader(host = '') {
  const value = String(host || '').trim().toLowerCase();
  if (!value) {
    return false;
  }
  const hostname = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isIpAllowed(ip, allowedIps) {
  return allowedIps.some((entry) => isIpMatch(ip, entry));
}

function isIpMatch(ip, entry) {
  const value = String(entry || '').trim();
  if (!value) {
    return false;
  }
  if (value === '*' || value === '0.0.0.0/0') {
    return true;
  }
  if (!value.includes('/')) {
    return normalizeClientIp(value) === ip;
  }
  return isIpv4InCidr(ip, value);
}

function isIpv4InCidr(ip, cidr) {
  const [base, prefixText] = cidr.split('/');
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  const prefix = Number(prefixText);
  if (ipInt == null || baseInt == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      return null;
    }
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function allow(scope, extra = {}) {
  return {
    allowed: true,
    scope,
    ...extra,
  };
}

function deny(statusCode, message, clientIp, appId = null) {
  return {
    allowed: false,
    statusCode,
    message,
    clientIp,
    appId,
  };
}
