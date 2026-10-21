import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd();
const installer = path.join(root, 'release-tauri', 'VK Player_0.2.0_x64-setup.exe');
const bundled = path.join(process.env.LOCALAPPDATA, 'vk-player-build', 'target', 'release', 'bundle', 'nsis', 'VK Player_0.2.0_x64-setup.exe');
const installed = path.join(process.env.LOCALAPPDATA, 'VK Player', 'vk-player.exe');
const built = path.join(process.env.LOCALAPPDATA, 'vk-player-build', 'target', 'release', 'vk-player.exe');
const bytes = await Promise.all([installer, bundled, installed, built].map(file => readFile(file)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(bytes[0]), sha(bytes[1]), 'Copied installer differs from packaged installer');
assert.equal(bytes[2].length, bytes[3].length);
const differences = [];
for (let i = 0; i < bytes[2].length; i++) if (bytes[2][i] !== bytes[3][i]) differences.push(i);
assert.equal(differences.length, 3, 'Unexpected installed/build executable differences');
assert.deepEqual(differences, [differences[0], differences[0] + 1, differences[0] + 2]);
assert.equal(bytes[2].subarray(differences[0] - 9, differences[0] + 3).toString(), 'TYPE_VAR_NSS');
assert.equal(bytes[3].subarray(differences[0] - 9, differences[0] + 3).toString(), 'TYPE_VAR_UNK');
const reports = await Promise.all(['installed-v02-warm-result.json', 'installed-v02-warm-repeat-result.json', 'installed-v02-playback-smoke-result.json'].map(async file => ({ file: `qa/${file}`, report: JSON.parse(await readFile(path.join(root, 'qa', file), 'utf8')) })));
assert.ok(reports.every(item => item.report.installedVersion === '0.2.0' && item.report.cloudReadOnly && item.report.localStateRestore?.nativeReadbackMatched));
const result = {
  checkedAt: new Date().toISOString(), version: '0.2.0',
  artifacts: [installer, installed, built].map((file, i) => ({ path: file, bytes: bytes[i === 0 ? 0 : i + 1].length, sha256: sha(bytes[i === 0 ? 0 : i + 1]) })),
  installerMatchesBundlerOutput: true,
  installedMatchesBuiltExceptNsisBundleTypeMarker: true,
  executableDifferenceBytes: differences.length,
  liveEvidence: reports.map(({ file, report }) => ({ file, checkedAt: report.checkedAt, localStateRestoreMatched: report.localStateRestore.nativeReadbackMatched })),
  cloudWritesDuringQa: false,
  limits: ['Cloud add/delete are covered by isolated tests and actual service availability inspection; user tracks were not modified.', 'Playback check for this version was muted and short; the prior full-track result is separate.', 'VK may revoke or expire its saved authorization.'],
};
await writeFile(path.join(root, 'qa', 'release-v02-proof.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
