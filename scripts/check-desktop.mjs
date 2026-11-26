import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const installed = process.argv[2];
const require = createRequire(import.meta.url);
const executable = installed ? resolve(installed) : require('electron');
const root = resolve('data/desktop-smoke');
await mkdir(root, { recursive: true });
const folder = await mkdtemp(join(root, installed ? 'packaged-' : 'development-'));
const child = spawn(executable, [...(installed ? [] : [resolve('.')]), '--verify-desktop'], {
  windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, PLANNER_SMOKE_DIRECTORY: folder },
});
await new Promise((done, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('桌面验证超时')); }, 100_000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    if (code === 0) done();
    else reject(new Error('桌面验证进程结束，状态 ' + (code ?? signal)));
  });
});
const result = JSON.parse(await readFile(join(folder, 'result.json'), 'utf8'));
console.log(JSON.stringify({ folder, ...result }));
