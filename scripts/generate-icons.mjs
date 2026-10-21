import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'vk-player-icons-'));
const icons = path.join(root, 'src-tauri', 'icons');
try {
  const result = spawnSync(process.execPath, [
    path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
    'icon', path.join(icons, 'app-icon.svg'), '--output', temporary,
  ], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generator exited with ${result.status}`);
  for (const name of ['icon.ico', 'icon.png', '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png']) {
    copyFileSync(path.join(temporary, name), path.join(icons, name));
  }
  console.log('Windows app and tray icons regenerated from src-tauri/icons/app-icon.svg');
} finally {
  // This is exclusively the directory created above, never an input or output directory.
  rmSync(temporary, { recursive: true, force: true });
}
