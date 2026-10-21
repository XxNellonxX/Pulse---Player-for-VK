import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'vk-player-qa-native-'));
let app;
try {
  const sampleRate = 8000, samples = sampleRate * 30;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8); wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
  const fixture = path.join(root, 'QA native.wav');
  await writeFile(fixture, wave);
  const profile = path.join(root, 'profile');
  app = await electron.launch({ args: [fileURLToPath(new URL('./electron-bootstrap.cjs', import.meta.url))], env: { ...process.env, VK_PLAYER_QA_PROFILE: profile } });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.locator('.app-shell').waitFor({ timeout: 15000 });
  await app.evaluate(({ dialog }, fixture) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] }); }, fixture);
  await page.getByRole('button', { name: 'Добавить файлы', exact: true }).first().click();
  await page.getByRole('button', { name: 'Воспроизвести QA native', exact: true }).waitFor({ timeout: 10000 });
  console.log('PASS native import reads real WAV through inspectAudio');
  await page.getByRole('button', { name: 'Воспроизвести QA native', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(2300);
  assert.ok(await page.getByLabel('Позиция воспроизведения').inputValue() > 1, 'native pulse-media playback never advanced');
  console.log('PASS native pulse-media protocol plays and advances');
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await page.waitForTimeout(500);
  const saved = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'));
  assert.equal(saved.state.tracks.length, 1);
  assert.ok(saved.state.position > 1);
  assert.equal(saved.files.length, 1);
  console.log('PASS native library and queue persist to isolated profile');
  assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  console.log('PASS native renderer has no page errors');
} finally {
  if (app) await app.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
