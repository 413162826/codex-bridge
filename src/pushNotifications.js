import crypto from 'node:crypto';

import webpush from 'web-push';

const DEFAULT_SUBJECT = process.env.CODEX_BRIDGE_VAPID_SUBJECT || 'mailto:codex-bridge@local';
const MAX_BODY_CHARS = 120;

export class PushNotificationStore {
  constructor({ state = {}, subject = DEFAULT_SUBJECT, client = webpush } = {}) {
    this.client = client;
    this.subject = subject;
    this.vapidKeys = normalizeVapidKeys(state.vapidKeys) || this.client.generateVAPIDKeys();
    this.subscriptions = new Map();

    for (const record of state.subscriptions || []) {
      const normalized = normalizeRecord(record);
      if (normalized) this.subscriptions.set(normalized.id, normalized);
    }

    this.client.setVapidDetails(this.subject, this.vapidKeys.publicKey, this.vapidKeys.privateKey);
  }

  publicInfo() {
    return {
      supported: true,
      publicKey: this.vapidKeys.publicKey,
      subscriptionCount: [...this.subscriptions.values()].filter((item) => item.enabled !== false).length,
    };
  }

  toJSON() {
    return {
      vapidKeys: this.vapidKeys,
      subscriptions: [...this.subscriptions.values()],
    };
  }

  upsert({ subscription, appId = null, deviceName = '', userAgent = '' } = {}) {
    const endpoint = String(subscription?.endpoint || '').trim();
    const keys = subscription?.keys || {};
    if (!endpoint || !keys.p256dh || !keys.auth) {
      const error = new Error('缺少有效的 Web Push subscription');
      error.statusCode = 400;
      throw error;
    }

    const now = new Date().toISOString();
    const id = idForEndpoint(endpoint);
    const existing = this.subscriptions.get(id);
    const record = {
      id,
      appId: appId || existing?.appId || null,
      deviceName: String(deviceName || existing?.deviceName || '').slice(0, 80),
      endpoint,
      subscription: {
        endpoint,
        expirationTime: subscription.expirationTime ?? null,
        keys: {
          p256dh: String(keys.p256dh),
          auth: String(keys.auth),
        },
      },
      userAgent: String(userAgent || existing?.userAgent || '').slice(0, 220),
      enabled: true,
      failures: 0,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastSeenAt: now,
      lastSuccessAt: existing?.lastSuccessAt || null,
      lastError: null,
    };
    this.subscriptions.set(id, record);
    return publicRecord(record);
  }

  remove({ id = '', endpoint = '' } = {}) {
    const key = id || (endpoint ? idForEndpoint(endpoint) : '');
    return key ? this.subscriptions.delete(key) : false;
  }

  find({ id = '', endpoint = '' } = {}) {
    const key = id || (endpoint ? idForEndpoint(endpoint) : '');
    const record = key ? this.subscriptions.get(key) : null;
    return record ? publicRecord(record) : null;
  }

  async notifyAll(payload, { appId = null } = {}) {
    const targets = [...this.subscriptions.values()].filter((item) => {
      if (item.enabled === false) return false;
      if (!appId) return true;
      return !item.appId || item.appId === appId;
    });
    const results = await Promise.allSettled(targets.map((record) => this.send(record, payload)));
    return {
      attempted: targets.length,
      sent: results.filter((item) => item.status === 'fulfilled' && item.value?.ok).length,
      failed: results.filter((item) => item.status === 'fulfilled' && item.value?.ok === false).length,
    };
  }

  async send(record, payload) {
    const now = new Date().toISOString();
    try {
      await this.client.sendNotification(record.subscription, JSON.stringify(normalizePayload(payload)), {
        TTL: 60,
        urgency: 'normal',
      });
      record.failures = 0;
      record.lastSuccessAt = now;
      record.lastError = null;
      record.updatedAt = now;
      return { ok: true, id: record.id };
    } catch (error) {
      record.failures = Number(record.failures || 0) + 1;
      record.lastError = String(error?.body || error?.message || '推送失败').slice(0, 240);
      record.updatedAt = now;
      if (error?.statusCode === 404 || error?.statusCode === 410 || record.failures >= 5) {
        record.enabled = false;
      }
      return { ok: false, id: record.id, error: record.lastError };
    }
  }
}

export function buildCompletionPayload({ title = 'Codex 回复完成', body = '', url = '/m/index.htm', sessionId = '' } = {}) {
  const cleanBody = String(body || '点开继续这个会话').replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);
  return {
    title,
    body: cleanBody || '点开继续这个会话',
    url,
    sessionId,
    tag: sessionId ? `codex-${sessionId}` : 'codex-turn-complete',
    timestamp: Date.now(),
  };
}

function normalizePayload(payload) {
  return {
    title: String(payload?.title || 'Codex').slice(0, 80),
    body: String(payload?.body || '').slice(0, 180),
    url: String(payload?.url || '/m/index.htm'),
    sessionId: String(payload?.sessionId || ''),
    tag: String(payload?.tag || payload?.sessionId || 'codex-turn-complete').slice(0, 100),
    timestamp: Number(payload?.timestamp || Date.now()),
  };
}

function normalizeVapidKeys(value) {
  if (!value?.publicKey || !value?.privateKey) return null;
  return {
    publicKey: String(value.publicKey),
    privateKey: String(value.privateKey),
  };
}

function normalizeRecord(record) {
  const subscription = record?.subscription || record;
  const endpoint = String(subscription?.endpoint || record?.endpoint || '').trim();
  const keys = subscription?.keys || record?.keys || {};
  if (!endpoint || !keys.p256dh || !keys.auth) return null;
  const id = record.id || idForEndpoint(endpoint);
  return {
    id,
    appId: record.appId || null,
    deviceName: String(record.deviceName || '').slice(0, 80),
    endpoint,
    subscription: {
      endpoint,
      expirationTime: subscription.expirationTime ?? null,
      keys: {
        p256dh: String(keys.p256dh),
        auth: String(keys.auth),
      },
    },
    userAgent: String(record.userAgent || '').slice(0, 220),
    enabled: record.enabled !== false,
    failures: Number(record.failures || 0),
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
    lastSeenAt: record.lastSeenAt || null,
    lastSuccessAt: record.lastSuccessAt || null,
    lastError: record.lastError || null,
  };
}

function publicRecord(record) {
  return {
    id: record.id,
    appId: record.appId,
    deviceName: record.deviceName,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSuccessAt: record.lastSuccessAt,
  };
}

function idForEndpoint(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 24);
}
