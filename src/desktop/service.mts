import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readConfig } from '../config.mts';
import { AuthorizationRequired, TokenManager } from '../feishu/auth.mts';
import type { UserGrant } from '../feishu/auth.mts';
import { Dates } from '../feishu/dates.mts';
import { eventConnection } from '../feishu/events.mts';
import { createApi, FeishuError } from '../feishu/http.mts';
import { FeishuRemote } from '../feishu/remote.mts';
import { Store } from '../storage/store.mts';
import { lockApp } from '../storage/process-lock.mts';
import { WindowsVault } from '../storage/vault.mts';
import { SyncEngine } from '../sync/engine.mts';
import { runPeriodic } from '../sync/runner.mts';
import type { TaskCommand, TodoCommand } from '../sync/types.mts';
import { emptyCapabilities } from './contract.mts';
import type { Capabilities, ConnectionForm, SyncStatus, View } from './contract.mts';
import { checkedForm, envFromForm } from './preferences.mts';

type Config = ReturnType<typeof readConfig>;
type Active = {
  config: Config; store: Store; engine: SyncEngine; runner: ReturnType<typeof runPeriodic>;
  connection: ReturnType<typeof eventConnection>; metadata: Promise<void>; unlock: () => Promise<void>;
};

export class DesktopSync {
  #active?: Active;
  #status: SyncStatus = 'setup';
  #message = '配置飞书连接后开始同步';
  #lastSync?: number;
  #linking?: number;
  #connected = false;
  #capabilities: Capabilities = emptyCapabilities;
  #directory: string;
  #changed: () => void;
  #scopeFile: boolean;
  #capabilitiesLoaded = false;

  constructor(directory: string, scopedDatabases: boolean, changed: () => void) {
    this.#directory = directory;
    this.#changed = changed;
    this.#scopeFile = scopedDatabases;
  }

  config(form: ConnectionForm) {
    return readConfig(envFromForm(checkedForm(form), this.#directory));
  }

  #vault(config: Config) { return new WindowsVault<string>(config.directory, 'app-' + config.appKey); }
  #oauth(config: Config) { return new WindowsVault<UserGrant>(config.directory, 'oauth-' + config.appKey); }

  async hasSecret(form: ConnectionForm, bootstrap?: string) {
    try { return Boolean(await this.#vault(this.config(form)).load() ?? bootstrap); }
    catch { return false; }
  }

  async importSecret(config: Config, secret: string) {
    await mkdir(config.directory, { recursive: true });
    await this.#vault(config).save(secret);
  }

  async start(form: ConnectionForm, bootstrap?: string) {
    await this.stop();
    this.#capabilitiesLoaded = false;
    this.#capabilities = emptyCapabilities;
    this.#lastSync = undefined;
    this.#linking = undefined;
    this.#connected = false;
    if (!form.appId) { this.#set('setup', '配置飞书连接后开始同步'); return; }
    let unlock: Awaited<ReturnType<typeof lockApp>> | undefined;
    let store: Store | undefined;
    try {
      const config = this.config(form);
      const secret = await this.#vault(config).load() ?? bootstrap;
      if (!secret) { this.#set('setup', '请在设置中导入包含 App Secret 的配置文件'); return; }
      await mkdir(config.directory, { recursive: true });
      unlock = await lockApp(config.appKey);
      store = this.#openStore(config);
      const tokens = new TokenManager({ appId: config.appId, secret }, this.#oauth(config));
      const remote = new FeishuRemote(createApi(tokens.access), { ...config, requireSharedCalendar: true });
      const engine = new SyncEngine(remote, store, count => {
        this.#linking = count;
        this.#set('syncing', `正在把 ${count} 条日程的关联写回飞书`);
      });
      const cached = store.get('capabilities');
      if (cached) this.#capabilities = cached;
      const runner = runPeriodic(engine, store, config.interval, error => {
        const failure = describeSyncError(error);
        this.#set(failure.status, failure.message);
      }, (syncing, success) => {
        if (syncing) this.#set('syncing', '正在同步飞书');
        else if (success) {
          this.#lastSync = Date.now();
          const pending = engine.desktopSnapshot();
          this.#set('synced', pending.pendingTasks + pending.pendingTodos
            ? '飞书已连接，待执行的修改将重试' : '与飞书保持同步');
          if (!this.#capabilitiesLoaded && this.#active) this.#loadCapabilities(this.#active, remote);
        }
      });
      const connection = eventConnection({ ...config, secret }, id => runner.trigger(id), line => {
        this.#connected = !line.includes('不可用');
        this.#changed();
      });
      const active = { config, store, engine, runner, connection, unlock, metadata: Promise.resolve() };
      this.#active = active;
      this.#loadCapabilities(active, remote);
      this.#set('idle', '正在准备同步');
    } catch (error) {
      store?.close();
      await unlock?.();
      this.#set('error', error instanceof Error ? error.message : '无法启动同步');
    }
  }

  #loadCapabilities(active: Active, remote: FeishuRemote) {
    this.#capabilitiesLoaded = true;
    active.metadata = remote.capabilities().then(result => {
      if (this.#active !== active) return;
      if (!result.task.length && !result.todo.length) { this.#capabilitiesLoaded = false; return; }
      this.#capabilities = result;
      active.store.put('capabilities', result);
      this.#changed();
    }).catch(() => { this.#capabilitiesLoaded = false; });
  }

  #openStore(config: Config) {
    const scoped = join(config.directory, 'planner-' + config.scope + '.db');
    if (this.#scopeFile) return new Store(scoped, config.scope);
    try { return new Store(join(config.directory, 'planner.db'), config.scope); }
    catch (error) {
      if (error instanceof Error && error.message.includes('属于其他飞书资源')) return new Store(scoped, config.scope);
      throw error;
    }
  }

  async stop() {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    active.connection.stop();
    await Promise.all([active.runner.stop(), active.metadata]);
    active.store.close();
    await active.unlock();
  }

  view(form: ConnectionForm): Omit<View, 'mode' | 'theme' | 'indentTodoPriorities'> {
    const zone = this.#active?.config.zone ?? form.zone;
    let today: string;
    try { today = new Dates(zone).day(Date.now())!; }
    catch { today = new Dates('Asia/Shanghai').day(Date.now())!; }
    const snapshot = this.#active?.engine.desktopSnapshot()
      ?? { tasks: [], todos: [], pendingTasks: 0, pendingTodos: 0, conflicts: 0 };
    return { ...snapshot, status: this.#status, message: this.#message, lastSync: this.#lastSync, linking: this.#linking,
      connected: this.#connected, zone, today, capabilities: this.#capabilities };
  }

  #set(status: SyncStatus, message: string) {
    this.#status = status;
    this.#message = message;
    if (status !== 'syncing') this.#linking = undefined;
    this.#changed();
  }

  #ready() {
    if (!this.#active) throw new Error('请先连接飞书');
    return this.#active;
  }

  task(command: TaskCommand) {
    const { engine, runner } = this.#ready();
    const current = 'id' in command ? engine.desktopSnapshot().tasks.find(task => task.id === command.id) : undefined;
    if ('id' in command && !current) throw new Error('任务已更新，请刷新后重试');
    if (command.kind !== 'delete') {
      const { start, end } = { ...current, ...command.values };
      if (start && end && start > end) throw new Error('截止日期不能早于开始日期');
    }
    engine.enqueueTask(command);
    this.#changed();
    runner.trigger();
  }

  todo(command: TodoCommand) {
    const { engine, runner } = this.#ready();
    if ('id' in command && !engine.desktopSnapshot().todos.some(todo => todo.id === command.id)) {
      throw new Error('待办已更新，请刷新后重试');
    }
    engine.enqueueTodo(command);
    this.#changed();
    runner.trigger();
  }

  order(ids: string[]) {
    const { engine, runner } = this.#ready();
    engine.orderTodos(ids);
    this.#changed();
    runner.trigger();
  }

  refresh(retry = true) {
    const active = this.#active;
    if (!active) return;
    if (retry) active.engine.retryPending();
    active.runner.trigger();
  }

  async authorize(form: ConnectionForm, bootstrap: string | undefined, open: (url: URL) => Promise<void>) {
    const config = this.config(form);
    const secret = await this.#vault(config).load() ?? bootstrap;
    if (!secret) throw new Error('请先导入包含 App Secret 的配置文件');
    await this.stop();
    const unlock = await lockApp(config.appKey);
    try {
      this.#set('authorization', '请在系统浏览器完成飞书授权');
      const manager = new TokenManager({ appId: config.appId, secret }, this.#oauth(config));
      await manager.authorize(config.redirect, config.oauthScopes, open);
      await this.#vault(config).save(secret);
    } finally {
      await unlock();
      await this.start(form, bootstrap);
    }
  }
}

function describeSyncError(error: unknown): { status: SyncStatus; message: string } {
  if (error instanceof AggregateError) {
    const failures = error.errors.map(describeSyncError);
    return failures.find(item => item.status === 'authorization')
      ?? failures.find(item => item.status === 'error') ?? failures[0]
      ?? { status: 'error', message: '同步失败' };
  }
  if (error instanceof AuthorizationRequired) return { status: 'authorization', message: '飞书用户授权需要更新' };
  if (error instanceof FeishuError && (error.status === 403 || [99991672, 99991679].includes(error.code))) {
    return { status: 'error', message: '飞书权限不足，请检查表或共享日历的读写权限' };
  }
  if (error instanceof Error && error.message.includes('网络连接')) {
    return { status: 'offline', message: '暂时无法连接飞书，本地缓存和修改可用' };
  }
  return { status: 'error', message: error instanceof Error ? error.message : '同步失败，可手动重试' };
}
