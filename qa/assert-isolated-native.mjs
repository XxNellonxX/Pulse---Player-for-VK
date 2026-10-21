import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// VK_PLAYER_QA_PROFILE is deliberately compiled out of production builds.
// Never trust the executable's filename or an arbitrary TAURI_QA_EXE override.
// This preflight reads the binary; it does not launch the player.
export async function assertIsolatedNativeBinary(executable) {
  const resolved = await realpath(executable);
  const bytes = await readFile(resolved);
  for (const marker of ['VK_PLAYER_QA_PROFILE', 'VK_PLAYER_QA_FILES']) {
    if (!bytes.includes(Buffer.from(marker))) {
      throw new Error('Refusing native QA: this executable lacks the debug-only isolated profile support. Build with --debug --config qa/tauri.config.json; production releases must never run mutating fixture tests.');
    }
  }
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('inspect-native-binary.ps1', import.meta.url)),
    '-QaBinary', resolved,
  ], { windowsHide: true, encoding: 'utf8' });
  const info = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (info.productName !== 'VK Player QA') {
    throw new Error('Refusing native QA: the executable is not the separate VK Player QA application. Build with --debug --config qa/tauri.config.json to keep its instance and data separate from the installed player.');
  }
}
