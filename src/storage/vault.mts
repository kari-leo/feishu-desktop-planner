import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class WindowsVault<T> {
  #path: string;

  constructor(directory: string, name: string) {
    this.#path = join(directory, name + '.dpapi');
  }

  async load(): Promise<T | undefined> {
    let data: string;
    try { data = await readFile(this.#path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return JSON.parse(await dpapi('Unprotect', data));
  }

  async save(value: T) {
    const encrypted = await dpapi('Protect', JSON.stringify(value));
    const temporary = this.#path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', flush: true });
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function dpapi(method: 'Protect' | 'Unprotect', input: string): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('凭证存储需要 Windows DPAPI'));
  const commands = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$value = [Console]::In.ReadToEnd()',
    method === 'Protect'
      ? '$bytes = [Text.Encoding]::UTF8.GetBytes($value)'
      : '$bytes = [Convert]::FromBase64String($value)',
    `$out = [Security.Cryptography.ProtectedData]::${method}($bytes, $null, 'CurrentUser')`,
    method === 'Protect'
      ? '[Console]::Write([Convert]::ToBase64String($out))'
      : '[Console]::Write([Text.Encoding]::UTF8.GetString($out))',
  ];
  // ASCII transport avoids console encoding differences. The encrypted payload is always Base64.
  const data = method === 'Protect'
    ? input.replace(/[^\x00-\x7F]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
    : input;
  return new Promise((resolve, reject) => {
    const cp = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      commands.join('; ')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    cp.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    const fail = () => reject(new Error('Windows DPAPI 无法访问本地授权凭证'));
    cp.stdin.on('error', fail);
    cp.on('error', fail);
    cp.on('close', code => code === 0 ? resolve(output) : fail());
    cp.stdin.end(data);
  });
}
