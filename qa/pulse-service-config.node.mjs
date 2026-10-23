import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gatewayOrigin, loadGatewayOrigin } from '../scripts/pulse-service-config.mjs';

test('desktop service config embeds only a public HTTPS origin', () => {
  assert.equal(gatewayOrigin(' https://music.pulse.example/ '), 'https://music.pulse.example');
  assert.equal(gatewayOrigin(''), '');
  for (const value of ['http://music.example', 'https://localhost', 'https://music.local', 'https://127.0.0.1', 'https://[::1]', 'https://music.example:8080', 'https://user:secret@music.example', 'https://music.example/v1', 'https://music.example?key=secret', 'https://music.example/#x']) assert.throws(() => gatewayOrigin(value));
});

test('service config is optional, strict and can be explicitly disabled by build environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-public-config-'));
  try {
    assert.equal(await loadGatewayOrigin(root, {}), '');
    await mkdir(path.join(root, 'config'));
    const file = path.join(root, 'config', 'pulse-service.json');
    await writeFile(file, JSON.stringify({ gatewayUrl: 'https://music.pulse.example' }));
    assert.equal(await loadGatewayOrigin(root, {}), 'https://music.pulse.example');
    assert.equal(await loadGatewayOrigin(root, { PULSE_GATEWAY_URL: '' }), '');
    assert.equal(await loadGatewayOrigin(root, { PULSE_GATEWAY_URL: 'https://other.example' }), 'https://other.example');
    await writeFile(file, JSON.stringify({ gatewayUrl: 'https://music.example', clientSecret: 'fixture-should-never-be-embedded' }));
    await assert.rejects(loadGatewayOrigin(root, {}), /only gatewayUrl/);
    await writeFile(file, '{malformed fixture-should-never-be-embedded');
    await assert.rejects(loadGatewayOrigin(root, {}), error => !error.message.includes('fixture-should-never-be-embedded'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared public default is used by clean builds, while local and environment overrides remain explicit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pulse-default-service-'));
  try {
    await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, 'config', 'pulse-service.default.json'), JSON.stringify({ gatewayUrl: 'https://pilot.example.org' }));
    assert.equal(await loadGatewayOrigin(root, {}), 'https://pilot.example.org');
    assert.equal(await loadGatewayOrigin(root, { PULSE_GATEWAY_URL: '' }), '');
    await writeFile(path.join(root, 'config', 'pulse-service.json'), JSON.stringify({ gatewayUrl: 'https://local-override.example.org' }));
    assert.equal(await loadGatewayOrigin(root, {}), 'https://local-override.example.org');
    assert.equal(await loadGatewayOrigin(root, { PULSE_GATEWAY_URL: 'https://env-override.example.org' }), 'https://env-override.example.org');
  } finally { await rm(root, { recursive: true, force: true }); }
});
