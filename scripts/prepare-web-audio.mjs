import { readFile, mkdir, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../node_modules/hls.js/dist/hls.light.min.js', import.meta.url), 'utf8');
const wrapper = '(()=>{const module={exports:{}};const exports=module.exports;\n' + source + '\nwindow.__PULSE_HLS__=module.exports;})();\n';
const directory = new URL('../src-tauri/resources/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('vk_hls.js', directory), wrapper);
