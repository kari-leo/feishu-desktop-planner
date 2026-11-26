import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig } from './config.mts';
import { TokenManager } from './feishu/auth.mts';
import type { UserGrant } from './feishu/auth.mts';
import { eventConnection } from './feishu/events.mts';
import { createApi } from './feishu/http.mts';
import { FeishuRemote } from './feishu/remote.mts';
import { Store } from './storage/store.mts';
import { lockApp } from './storage/process-lock.mts';
import { WindowsVault } from './storage/vault.mts';
import { SyncEngine } from './sync/engine.mts';
import { runPeriodic } from './sync/runner.mts';

async function main(command: string | undefined, file?: string) {
  if (!command || command === 'help' || command === '--help') {
    console.log('npm run planner -- authorize | import-token <file> | doctor | once | run | status');
    return;
  }
  if (!['authorize', 'import-token', 'doctor', 'once', 'run', 'status'].includes(command)) {
    throw new Error('未知命令，请运行 npm run planner -- help');
  }
  const config = readConfig();
  await mkdir(config.directory, { recursive: true });
  const closeLock = command === 'status' ? undefined : await lockApp(config.appKey);
  try {
    const secretVault = new WindowsVault<string>(config.directory, 'app-' + config.appKey);
    const oauthVault = new WindowsVault<UserGrant>(config.directory, 'oauth-' + config.appKey);
    const savedSecret = command === 'status' ? '' : await secretVault.load();
    const secret = command === 'authorize' ? config.bootstrapSecret ?? savedSecret
      : savedSecret ?? config.bootstrapSecret;
    if (secret === undefined) throw new Error('缺少 App Secret，首次授权前请设置 FEISHU_APP_SECRET');
    const tokens = new TokenManager({ appId: config.appId, secret }, oauthVault);
    if (command === 'import-token') {
      if (!file) throw new Error('请提供首次飞书 OAuth 回调的 JSON 文件');
      let result;
      let received;
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > 65_536) throw new Error();
        result = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
        received = info.mtimeMs;
      } catch {
        throw new Error('无法读取首次飞书 OAuth 回调 JSON');
      }
      await tokens.importInitial(result, received);
      await secretVault.save(secret);
      console.log('首次飞书授权已加密导入');
      return;
    }
    if (command === 'authorize') {
      console.log('正在等待系统浏览器完成飞书授权');
      await tokens.authorize(config.redirect, config.oauthScopes, openBrowser);
      await secretVault.save(secret);
      console.log('飞书授权已加密保存');
      return;
    }
    const remote = new FeishuRemote(createApi(tokens.access), config);
    if (command === 'doctor') {
      const report = await remote.inspect();
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      return;
    }
    const store = new Store(join(config.directory, 'planner.db'), config.scope);
    const engine = new SyncEngine(remote, store);
    try {
      if (command === 'run') await serve(engine, store, { ...config, secret });
      else {
        if (command === 'once') await engine.sync();
        const { tasks, todos, pendingTodos, conflicts } = engine.snapshot();
        console.log(JSON.stringify({ tasks: tasks.length, todos: todos.length, pendingTodos, conflicts }));
      }
    } finally {
      store.close();
    }
  } finally {
    await closeLock?.();
  }
}

async function openBrowser(url: URL) {
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url.href], {
    windowsHide: true, stdio: 'ignore',
  });
  await once(child, 'spawn');
  child.unref();
}

async function serve(
  engine: SyncEngine, store: Store, config: ReturnType<typeof readConfig> & { secret: string },
) {
  let last = '';
  const runner = runPeriodic(engine, store, config.interval, error => {
    const message = describe(error);
    if (message !== last) console.error(message);
    last = message;
  });
  const connection = eventConnection(config, runner.trigger, console.log);
  console.log('同步服务已启动，按 Ctrl+C 退出');
  try {
    await new Promise<void>(resolve => {
      const stop = () => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
  } finally {
    connection.stop();
    await runner.stop();
  }
}

function describe(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(describe).join('\n');
  return error instanceof Error ? error.message : '操作失败';
}

await main(process.argv[2], process.argv[3]).catch(error => {
  console.error(describe(error));
  process.exitCode = 1;
});
