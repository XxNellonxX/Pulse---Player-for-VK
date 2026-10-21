import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), version = '0.3.0';
const installer = path.join(root, 'release-tauri', `VK Player_${version}_x64-setup.exe`);
const bundled = path.join(process.env.LOCALAPPDATA, 'vk-player-build', 'target', 'release', 'bundle', 'nsis', `VK Player_${version}_x64-setup.exe`);
const installed = path.join(process.env.LOCALAPPDATA, 'VK Player', 'vk-player.exe');
const built = path.join(process.env.LOCALAPPDATA, 'vk-player-build', 'target', 'release', 'vk-player.exe');
const bytes = await Promise.all([installer, bundled, installed, built].map(file => readFile(file)));
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(bytes[0]), sha(bytes[1]));
assert.equal(bytes[2].length, bytes[3].length);
const differences = [];
for (let index = 0; index < bytes[2].length; index++) if (bytes[2][index] !== bytes[3][index]) differences.push(index);
assert.equal(differences.length, 3, 'Unexpected installed/build executable difference');
assert.deepEqual(differences, [differences[0], differences[0] + 1, differences[0] + 2]);
assert.equal(bytes[2].subarray(differences[0] - 9, differences[0] + 3).toString(), 'TYPE_VAR_NSS');
assert.equal(bytes[3].subarray(differences[0] - 9, differences[0] + 3).toString(), 'TYPE_VAR_UNK');
const readReport = async file => JSON.parse(await readFile(path.join(root, 'qa', file), 'utf8'));
const product = await readReport('independent-v03-results.json');
assert.ok(product.results.length >= 23 && product.results.every(result => result.pass));
const live = await readReport('installed-v03-acceptance-result.json');
assert.equal(live.version, version); assert.equal(live.success, true); assert.equal(live.cloudReadOnly, true);
assert.equal(live.localStateRestore.nativeReadbackMatched, true);
assert.ok(live.cases.some(item => item.case === 'ownLibraryPlayback' && item.secondsSampled >= 120));
assert.ok(live.cases.some(item => item.case === 'artistApiPlayback'));
const warm = await readReport('installed-v03-warm-cache-result.json');
assert.equal(warm.success, true); assert.equal(warm.artistModuleWasAbsent, true);
assert.equal(warm.cacheHit, true); assert.equal(warm.localStateRestore.nativeReadbackMatched, true);
const normal = await readReport('installed-process-state-result.json');
assert.equal(normal.installedInstances, 1); assert.equal(normal.temporaryDebugPortClosed, true); assert.equal(normal.idleImportToolProcesses, 0);
const result = {
  checkedAt: new Date().toISOString(), version,
  artifacts: [installer, installed, built].map((file, index) => ({ path: file, bytes: bytes[index ? index + 1 : 0].length, sha256: sha(bytes[index ? index + 1 : 0]) })),
  installerMatchesBundlerOutput: true, installedMatchesBuiltExceptNsisBundleTypeMarker: true,
  independentFrontendScenarios: product.results.length,
  nativeAcceptance: 'qa/installed-v03-acceptance-result.json',
  coldRegistryCacheRestart: 'qa/installed-v03-warm-cache-result.json',
  normalLaunch: 'qa/installed-process-state-result.json',
  preferencesQueuePositionRestored: true, cloudWritesDuringQa: false,
  limits: [
    'Cloud library/playlist/follow writes were tested with isolated service responses; the real user account was not modified.',
    'Muted playback checks measure media progress and buffer delivery; they cannot guarantee the absence of every audible interruption under every network condition.',
    'Artist data and source availability depend on the signed-in VK account and current website interface; missing metrics are not invented.',
  ],
};
await writeFile(path.join(root, 'qa', 'release-v03-proof.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
