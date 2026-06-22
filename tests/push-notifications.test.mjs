import assert from 'node:assert/strict';
import test from 'node:test';

import { PushNotificationStore, buildCompletionPayload } from '../src/pushNotifications.js';

function subscription(endpoint = 'https://push.example.test/a') {
  return {
    endpoint,
    keys: {
      p256dh: 'p256dh-key',
      auth: 'auth-key',
    },
  };
}

function fakeClient({ failStatus = 0 } = {}) {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys() {
      return { publicKey: 'public-vapid', privateKey: 'private-vapid' };
    },
    setVapidDetails(subject, publicKey, privateKey) {
      this.vapid = { subject, publicKey, privateKey };
    },
    async sendNotification(target, payload, options) {
      if (failStatus) {
        const error = new Error('gone');
        error.statusCode = failStatus;
        throw error;
      }
      sent.push({ target, payload: JSON.parse(payload), options });
    },
  };
}

test('push notifications generate VAPID keys and persist subscriptions', () => {
  const client = fakeClient();
  const store = new PushNotificationStore({ state: {}, client });

  const record = store.upsert({
    subscription: subscription(),
    appId: 'app-1',
    deviceName: 'iPhone',
    userAgent: 'Mobile Safari',
  });

  assert.equal(store.publicInfo().publicKey, 'public-vapid');
  assert.equal(store.publicInfo().subscriptionCount, 1);
  assert.equal(record.deviceName, 'iPhone');
  assert.equal(store.toJSON().subscriptions[0].appId, 'app-1');
  assert.equal(store.find({ endpoint: subscription().endpoint }).id, record.id);
});

test('push notifications send completion payloads and keep private keys server-side', async () => {
  const client = fakeClient();
  const store = new PushNotificationStore({
    state: { vapidKeys: { publicKey: 'pub', privateKey: 'priv' } },
    client,
  });
  store.upsert({ subscription: subscription('https://push.example.test/b') });

  const result = await store.notifyAll(buildCompletionPayload({
    body: '模型回复已经完成',
    url: '/m/index.htm?sessionId=s1',
    sessionId: 's1',
  }));

  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(client.vapid.privateKey, 'priv');
  assert.equal(client.sent[0].payload.url, '/m/index.htm?sessionId=s1');
  assert.equal(client.sent[0].payload.sessionId, 's1');
  assert.equal(client.sent[0].options.TTL, 60);
});

test('push notifications disable expired subscriptions', async () => {
  const client = fakeClient({ failStatus: 410 });
  const store = new PushNotificationStore({ state: {}, client });
  store.upsert({ subscription: subscription('https://push.example.test/expired') });

  const result = await store.notifyAll(buildCompletionPayload());

  assert.deepEqual(result, { attempted: 1, sent: 0, failed: 1 });
  assert.equal(store.publicInfo().subscriptionCount, 0);
  assert.equal(store.toJSON().subscriptions[0].enabled, false);
});

test('push notifications find and remove subscriptions by endpoint', () => {
  const client = fakeClient();
  const store = new PushNotificationStore({ state: {}, client });
  const target = subscription('https://push.example.test/remove-me');
  store.upsert({ subscription: target });

  assert.equal(store.find({ endpoint: target.endpoint }).enabled, true);
  assert.equal(store.remove({ endpoint: target.endpoint }), true);
  assert.equal(store.find({ endpoint: target.endpoint }), null);
});
