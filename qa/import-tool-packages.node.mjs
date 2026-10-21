import assert from 'node:assert/strict';
import { importToolPackages } from '../scripts/import-tool-packages.mjs';

const win = importToolPackages('win32', 'x64');
assert.equal(win.find(item => item.executable === 'yt-dlp.exe').url.endsWith('/yt-dlp.exe'), true);
assert.ok(win.some(item => item.outputs?.includes('ffprobe.exe')));
for (const arch of ['arm64', 'x64']) {
  const mac = importToolPackages('darwin', arch);
  assert.equal(mac.find(item => item.executable === 'yt-dlp').url.endsWith('/yt-dlp_macos'), true);
  assert.ok(mac.some(item => item.executable === 'ffmpeg'));
  assert.ok(mac.some(item => item.executable === 'ffprobe'));
  assert.ok(mac.some(item => item.executable === 'deno'));
  assert.ok(mac.every(item => /^[a-f0-9]{64}$/.test(item.sha)));
}
assert.throws(() => importToolPackages('linux', 'x64'), /not packaged/);
console.log('PASS pinned URL import tool packages for Windows x64 and macOS arm64/x64');
