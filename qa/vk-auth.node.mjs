import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { VkAuth } from '../electron/vk-auth.mjs';

function storageMock() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value, 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8'),
  };
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function openCallback(authUrl) {
  const url = new URL(authUrl);
  const redirect = new URL(url.searchParams.get('redirect_uri'));
  redirect.searchParams.set('code', 'auth-code');
  redirect.searchParams.set('state', url.searchParams.get('state'));
  redirect.searchParams.set('device_id', 'device-1');
  return new Promise((resolve, reject) => {
    const request = http.get(redirect, response => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', reject);
  });
}

test('empty client id fails with an actionable setup blocker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-auth-qa-'));
  try {
    const auth = new VkAuth({ clientId: '', redirectUri: 'http://127.0.0.1:49281/callback', userData: root, openExternal: () => {}, safeStorage: storageMock() });
    await assert.rejects(auth.connect(), error => error.code === 'not_configured' && /client_id/.test(error.message));
    assert.equal((await auth.getStatus()).state, 'not-configured');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('connect uses PKCE, validates callback state, and stores no plaintext token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-auth-qa-'));
  const originalFetch = globalThis.fetch;
  const port = await freePort();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: new URLSearchParams(init.body) });
    const body = Object.fromEntries(new URLSearchParams(init.body));
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.code, 'auth-code');
    assert.equal(body.device_id, 'device-1');
    assert.equal(body.code_verifier.length >= 43, true);
    assert.equal(body.code_verifier.includes('='), false);
    return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, user_id: 42, state: body.state, scope: 'vkid.personal_info' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const auth = new VkAuth({ clientId: '12345', redirectUri: `http://127.0.0.1:${port}/callback`, userData: root, openExternal: openCallback, safeStorage: storageMock() });
    const status = await auth.connect({ timeoutMs: 5000 });
    assert.equal(status.state, 'connected');
    assert.equal(status.userId, 42);
    assert.equal(calls.length, 1);
    const saved = await readFile(path.join(root, 'vk-auth.json'), 'utf8');
    assert.match(saved, /"version":1/);
    assert.doesNotMatch(saved, /access-secret|refresh-secret/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('refresh is single-flight and logout invalidates late refresh completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-auth-qa-'));
  const originalFetch = globalThis.fetch;
  const port = await freePort();
  let resolveRefresh;
  let refreshCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    if (body.grant_type === 'authorization_code') return new Response(JSON.stringify({ access_token: 'access-a', refresh_token: 'refresh-a', expires_in: 1, user_id: 7, state: body.state }), { status: 200 });
    if (body.grant_type === 'refresh_token') {
      refreshCalls++;
      await new Promise(resolve => { resolveRefresh = resolve; });
      return new Response(JSON.stringify({ access_token: 'access-b', refresh_token: 'refresh-b', expires_in: 3600, user_id: 7, state: body.state }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: 1 }), { status: 200 });
  };
  try {
    const auth = new VkAuth({ clientId: '12345', redirectUri: `http://127.0.0.1:${port}/callback`, userData: root, openExternal: openCallback, safeStorage: storageMock() });
    await auth.connect({ timeoutMs: 5000 });
    auth.tokens.expiresAt = Date.now() - 100;
    const first = auth.refreshIfNeeded().then(() => null, error => error);
    const second = auth.refreshIfNeeded().then(() => null, error => error);
    for (let attempt = 0; attempt < 40 && refreshCalls === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(refreshCalls, 1);
    const logout = auth.disconnect();
    resolveRefresh();
    await logout;
    assert.ok(['cancelled', 'internal'].includes((await first)?.code));
    assert.ok(['cancelled', 'internal'].includes((await second)?.code));
    assert.equal((await auth.getStatus()).state, 'disconnected');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid callback state is answered without consuming the legitimate login', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-auth-qa-'));
  const originalFetch = globalThis.fetch;
  const port = await freePort();
  let exchanges = 0;
  let rejectedStatus;
  globalThis.fetch = async (_url, init) => {
    exchanges++;
    const values = Object.fromEntries(new URLSearchParams(init.body));
    return new Response(JSON.stringify({ access_token: 'access-a', refresh_token: 'refresh-a', expires_in: 3600, user_id: 7, state: values.state }), { status: 200 });
  };
  try {
    const auth = new VkAuth({ clientId: '12345', redirectUri: `http://127.0.0.1:${port}/callback`, userData: root, safeStorage: storageMock(), openExternal: async authUrl => {
      const authorize = new URL(authUrl);
      const wrong = new URL(authorize.searchParams.get('redirect_uri'));
      wrong.searchParams.set('code', 'intruder-code');
      wrong.searchParams.set('device_id', 'intruder-device');
      wrong.searchParams.set('state', 'wrong-state');
      await new Promise((resolve, reject) => {
        http.get(wrong, response => { rejectedStatus = response.statusCode; response.resume(); response.once('end', resolve); }).once('error', reject);
      });
      assert.equal(exchanges, 0);
      await openCallback(authUrl);
    } });
    assert.equal((await auth.connect({ timeoutMs: 5000 })).state, 'connected');
    assert.equal(rejectedStatus, 400);
    assert.equal(exchanges, 1);
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});

test('auth timeout releases its loopback listening port', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-auth-qa-'));
  const port = await freePort();
  try {
    const auth = new VkAuth({ clientId: '12345', redirectUri: `http://127.0.0.1:${port}/callback`, userData: root, safeStorage: storageMock(), openExternal: () => {} });
    await assert.rejects(auth.connect({ timeoutMs: 10 }), error => error.code === 'timeout');
    const replacement = http.createServer();
    await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => replacement.close(resolve));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a persisted rotationPending session requires login and never replays its consumed refresh token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-auth-qa-'));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('must not reach VK'); };
  try {
    const safeStorage = storageMock();
    const redirectUri = 'http://127.0.0.1:49281/callback';
    const interrupted = { clientId: '12345', redirectUri, accessToken: 'expired-access', refreshToken: 'consumed-refresh', deviceId: 'device-1', expiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 86400_000, userId: 7, scope: 'vkid.personal_info', rotationPending: true };
    const encrypted = safeStorage.encryptString(JSON.stringify(interrupted));
    await writeFile(path.join(root, 'vk-auth.json'), JSON.stringify({ version: 1, encrypted: encrypted.toString('base64') }), 'utf8');
    const restarted = new VkAuth({ clientId: '12345', redirectUri, userData: root, safeStorage, openExternal: () => {} });
    const status = await restarted.getStatus();
    assert.equal(status.state, 'error');
    assert.equal(status.requiresReauth, true);
    assert.equal(status.userId, null);
    await restarted.refreshIfNeeded();
    assert.equal(requests, 0);
    assert.equal(restarted.tokens, null);
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
