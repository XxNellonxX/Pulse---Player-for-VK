import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertIsolatedNativeBinary } from './assert-isolated-native.mjs';

const execFileAsync = promisify(execFile);
const scripts = ['tauri-integration.mjs', 'tauri-adversarial.mjs', 'tauri-vk-web.mjs', 'tauri-vk-upload.mjs', 'tauri-url-import.mjs'];

test('every mutating native suite refuses an untrusted executable override before starting a player', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-qa-guard-'));
  const binary = path.join(root, 'debug-vk-player.exe');
  await writeFile(binary, 'This file must never be executed.');
  try {
    for (const script of scripts) {
      await assert.rejects(execFileAsync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
        windowsHide: true, env: { ...process.env, TAURI_QA_EXE: binary },
      }), error => {
        assert.match(error.stderr, /Refusing native QA:/, `${script} did not reject at the shared isolation guard`);
        return true;
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('debug marker strings alone cannot impersonate the separate QA application', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-qa-marker-'));
  const binary = path.join(root, 'vk-player.exe');
  await writeFile(binary, 'VK_PLAYER_QA_PROFILE VK_PLAYER_QA_FILES');
  try { await assert.rejects(assertIsolatedNativeBinary(binary), /Refusing native QA:.*separate VK Player QA/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

const target = process.env.CARGO_TARGET_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build', 'target');
for (const [configuration, expected] of [['debug', true], ['release', false]]) {
  const binary = path.join(target, configuration, 'vk-player.exe');
  const available = process.platform === 'win32' && await access(binary).then(() => true, () => false);
  test(`built ${configuration} binary is ${expected ? 'accepted' : 'refused'} by read-only preflight`, { skip: !available }, async () => {
    if (expected) await assertIsolatedNativeBinary(binary);
    else await assert.rejects(assertIsolatedNativeBinary(binary), /Refusing native QA:/);
  });
}
