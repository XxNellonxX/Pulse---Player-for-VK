import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
await import('./prepare-web-audio.mjs');

const root = fileURLToPath(new URL('../', import.meta.url));
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
const env = { ...process.env };
if (existsSync(cargoBin)) env.PATH = `${cargoBin}${path.delimiter}${env.PATH || env.Path || ''}`;
// Keep compiler artifacts outside Documents, where Windows folder protection
// can reject rename operations performed by Rust's incremental compiler.
env.CARGO_TARGET_DIR ||= path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vk-player-build', 'target');
const args = process.argv.slice(2);
const cargo = args[0] === '--cargo';
const command = cargo ? (process.platform === 'win32' ? 'cargo.exe' : 'cargo') : process.execPath;
const cargoArgs = args.slice(1);
const separator = cargoArgs.indexOf('--');
if (cargo) cargoArgs.splice(separator < 0 ? cargoArgs.length : separator, 0, '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml'));
const commandArgs = cargo ? cargoArgs : [path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), ...args];
const child = spawn(command, commandArgs, { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.code === 'ENOENT' ? 'Rust/Cargo is required. Install a Rust MSVC toolchain and Windows Build Tools.' : error.message); process.exitCode = 1; });
child.on('exit', async (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exitCode = code ?? 1;
  if (!cargo && args[0] === 'build' && code === 0 && !args.includes('--debug') && !args.includes('--no-bundle')) {
    const requestedTargetIndex = args.indexOf('--target');
    const requestedTarget = requestedTargetIndex >= 0 ? args[requestedTargetIndex + 1] : undefined;
    const outputRoot = requestedTarget ? path.join(env.CARGO_TARGET_DIR, requestedTarget) : env.CARGO_TARGET_DIR;
    const bundleType = process.platform === 'darwin' ? 'dmg' : 'nsis';
    const bundleDir = path.join(outputRoot, 'release', 'bundle', bundleType);
    if (!existsSync(bundleDir)) return;
    const releaseDir = path.join(root, 'release-tauri');
    await mkdir(releaseDir, { recursive: true });
    for (const name of await readdir(bundleDir)) if (name.endsWith(process.platform === 'darwin' ? '.dmg' : '.exe')) await copyFile(path.join(bundleDir, name), path.join(releaseDir, name));
    console.log(`Installer copied to ${releaseDir}`);
  }
});
