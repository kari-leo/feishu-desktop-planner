import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, screen, session, shell, Tray } from 'electron';
import type { IpcMainInvokeEvent, Rectangle } from 'electron';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { taskCommand, todoCommand, recordId } from './commands.mts';
import { isTheme, themes } from './contract.mts';
import type { Appearance, Mode, Widget, WindowKind } from './contract.mts';
import { checkedForm, formFromEnv, PreferencesFile } from './preferences.mts';
import { DesktopSync } from './service.mts';

const title = '飞书桌面计划管理器';
const smokeDir = process.argv.includes('--verify-desktop') ? process.env.PLANNER_SMOKE_DIRECTORY : undefined;
const windows = new Map<WindowKind, BrowserWindow>();
const layouts = new Map<Widget, ReturnType<typeof setTimeout>>();
let prefs: PreferencesFile;
let service: DesktopSync;
let baseEnvironment: NodeJS.ProcessEnv = {};
let tray: Tray | undefined;
let exiting = false;
let stopped = false;
let operation = Promise.resolve<unknown>(undefined);
let dayTimer: ReturnType<typeof setInterval> | undefined;
let mode: Mode = 'browse';

if (smokeDir) {
  app.setPath('userData', resolve(smokeDir));
  app.disableHardwareAcceleration();
}
app.setAppUserModelId('com.windborne.feishuplanner');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (prefs) show('schedule'); });
  app.on('activate', () => { if (prefs) show('schedule'); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (stopped) return;
    event.preventDefault();
    if (exiting) return;
    exiting = true;
    clearInterval(dayTimer);
    for (const [kind, timer] of layouts) {
      clearTimeout(timer);
      saveBounds(kind);
    }
    for (const [kind, win] of windows) if (kind !== 'settings' && !win.isDestroyed()) saveBounds(kind);
    void service?.stop().finally(() => {
      stopped = true;
      tray?.destroy();
      app.quit();
    });
    if (!service) app.exit();
  });
  void app.whenReady().then(start).catch(error => {
    if (!smokeDir) dialog.showErrorBox(title, error instanceof Error ? error.message : '应用启动失败');
    console.error(error instanceof Error ? error.message : '应用启动失败');
    app.exit(1);
  });
}

async function start() {
  const data = app.getPath('userData');
  await mkdir(data, { recursive: true });
  if (!smokeDir) {
    baseEnvironment = { ...process.env };
    if (!app.isPackaged) {
      try { baseEnvironment = { ...parse(await readFile(join(app.getAppPath(), '.env'))), ...baseEnvironment }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const directory = app.isPackaged || smokeDir ? join(data, 'sync') : resolve(baseEnvironment.FEISHU_DATA_DIR || 'data');
  prefs = new PreferencesFile(join(data, 'planner-settings.json'));
  service = new DesktopSync(directory, app.isPackaged || Boolean(smokeDir), broadcast);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  Menu.setApplicationMenu(null);
  registerCommands();
  openWindow('schedule');
  openWindow('todo');
  if (smokeDir) {
    await verifyDesktop(smokeDir);
    return;
  }
  makeTray();
  powerMonitor.on('resume', () => { service.refresh(false); broadcast(); });
  screen.on('display-removed', reposition);
  screen.on('display-metrics-changed', reposition);
  let lastDay = state().today;
  dayTimer = setInterval(() => {
    const day = state().today;
    if (day !== lastDay) { lastDay = day; broadcast(); }
  }, 15_000);
  await service.start(form(), bootstrap());
}

function form() { return prefs.value.connection ?? formFromEnv(baseEnvironment); }
function bootstrap(current = form()) {
  return current.appId === baseEnvironment.FEISHU_APP_ID ? baseEnvironment.FEISHU_APP_SECRET : undefined;
}
function state() {
  const { theme, indentTodoPriorities } = prefs.value.appearance;
  return { ...service.view(form()), mode, theme, indentTodoPriorities };
}

function broadcast() {
  if (exiting || !service) return;
  const view = state();
  for (const win of windows.values()) if (!win.isDestroyed()) win.webContents.send('planner:state-changed', view);
}

const limits = {
  schedule: { width: 1000, height: 720, minWidth: 690, minHeight: 510 },
  todo: { width: 365, height: 560, minWidth: 300, minHeight: 390 },
  settings: { width: 674, height: 690, minWidth: 510, minHeight: 435 },
};

function suggested(kind: WindowKind): Rectangle {
  const area = screen.getPrimaryDisplay().workArea;
  const target = limits[kind];
  const width = Math.min(target.width, area.width);
  const height = Math.min(target.height, area.height);
  const gap = 22;
  const grouped = area.width >= limits.schedule.width + limits.todo.width + gap * 3;
  const left = area.x + Math.round((area.width - limits.schedule.width - limits.todo.width - gap) / 2);
  let x = area.x + Math.round((area.width - width) / 2);
  if (kind === 'schedule' && grouped) x = left;
  if (kind === 'todo') x = grouped ? left + limits.schedule.width + gap : area.x + area.width - width - gap;
  return { x, y: area.y + Math.max(0, Math.round((area.height - height) / 2) - 20), width, height };
}

function fit(bounds: Rectangle, kind: WindowKind): Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea;
  const target = limits[kind];
  const width = Math.min(area.width, Math.max(target.minWidth, bounds.width));
  const height = Math.min(area.height, Math.max(target.minHeight, bounds.height));
  return { width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) };
}

function openWindow(kind: WindowKind): BrowserWindow {
  const prior = windows.get(kind);
  if (prior && !prior.isDestroyed()) return prior;
  const configured = kind === 'settings' ? undefined : prefs.value.layout[kind];
  const win = new BrowserWindow({
    ...fit(configured ?? suggested(kind), kind), minWidth: limits[kind].minWidth, minHeight: limits[kind].minHeight,
    title: kind === 'todo' ? '今日待办 · 计划管理器' : kind === 'settings' ? '设置 · 计划管理器' : title,
    frame: false, show: false, backgroundColor: themes[prefs.value.appearance.theme].canvas,
    icon: join(__dirname, 'icon.png'),
    opacity: kind === 'settings' ? 1 : prefs.value.appearance.opacity, autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true,
      sandbox: true, spellcheck: false, backgroundThrottling: false,
    },
  });
  windows.set(kind, win);
  if (kind !== 'settings') applyMode(win, mode);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.once('ready-to-show', () => {
    if (smokeDir) return;
    if (kind !== 'settings' && mode === 'browse') win.showInactive();
    else win.show();
  });
  win.on('close', event => {
    if (exiting || kind === 'settings') return;
    event.preventDefault();
    saveBounds(kind);
    win.hide();
  });
  win.on('closed', () => { if (windows.get(kind) === win) windows.delete(kind); });
  if (kind !== 'settings') {
    const remember = () => {
      if (exiting || win.isMaximized() || win.isMinimized()) return;
      clearTimeout(layouts.get(kind));
      layouts.set(kind, setTimeout(() => { layouts.delete(kind); saveBounds(kind); }, 180));
    };
    win.on('move', remember);
    win.on('resize', remember);
  }
  void win.loadFile(join(__dirname, 'index.html'), { query: { widget: kind } }).catch(error => {
    console.error('界面加载失败', error.message);
  });
  return win;
}

function show(kind: WindowKind) {
  const win = openWindow(kind);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function saveBounds(kind: Widget) {
  const win = windows.get(kind);
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
  prefs.save({ layout: { ...prefs.value.layout, [kind]: win.getBounds() } });
}

function reposition() {
  for (const [kind, win] of windows) {
    if (!win.isDestroyed() && !win.isMaximized()) win.setBounds(fit(win.getBounds(), kind));
  }
}

function applyMode(win: BrowserWindow, mode: Mode) {
  const browsing = mode === 'browse';
  win.setMovable(!browsing);
  win.setResizable(!browsing);
  win.setSkipTaskbar(browsing);
}

function changeMode(next: Mode) {
  mode = next;
  for (const [kind, win] of windows) if (kind !== 'settings' && !win.isDestroyed()) {
    if (mode === 'browse') saveBounds(kind);
    applyMode(win, mode);
  }
  trayMenu();
  broadcast();
}

function makeTray() {
  tray = new Tray(join(__dirname, 'icon.png'));
  tray.setToolTip(title);
  tray.on('double-click', () => show('schedule'));
  trayMenu();
}

function trayMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: '打开排期日历', click: () => show('schedule') },
    { label: '打开今日待办', click: () => show('todo') },
    { type: 'separator' },
    { label: '调整挂件布局', type: 'checkbox', checked: mode === 'edit',
      click: item => changeMode(item.checked ? 'edit' : 'browse') },
    { label: '立即同步', click: () => service.refresh() },
    { label: '设置', click: () => show('settings') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function runExclusive<T>(callback: () => Promise<T>) {
  const next = operation.then(callback, callback);
  operation = next.catch(() => undefined);
  return next;
}

function registerCommands() {
  const register = (name: string, action: (window: BrowserWindow, input: unknown) => unknown) => {
    ipcMain.handle('planner:' + name, (event: IpcMainInvokeEvent, input: unknown) => {
      const win = [...windows.values()].find(candidate => candidate.webContents.id === event.sender.id);
      if (!win || !event.senderFrame || event.senderFrame.parent
        || !/^file:/.test(event.senderFrame.url)) throw new Error('应用窗口无权执行此操作');
      return action(win, input);
    });
  };
  register('state', state);
  register('task', (_win, input) => service.task(taskCommand(input)));
  register('todo', (_win, input) => service.todo(todoCommand(input)));
  register('order', (_win, input) => {
    if (!Array.isArray(input) || input.length < 2 || input.length > 1000) throw new Error('排序请求无效');
    const ids = input.map(recordId);
    if (new Set(ids).size !== ids.length) throw new Error('排序列表有重复项');
    service.order(ids);
  });
  register('refresh', () => service.refresh());
  register('settings', async () => ({
    connection: form(), appearance: prefs.value.appearance, hasSecret: await service.hasSecret(form(), bootstrap()),
  }));
  register('connection', (_win, input) => runExclusive(async () => {
    const connection = checkedForm(input);
    service.config(connection);
    prefs.save({ connection });
    await service.start(connection, bootstrap(connection));
  }));
  register('import', win => runExclusive(async () => {
    const selected = await dialog.showOpenDialog(win, { title: '导入飞书 .env 配置', properties: ['openFile', 'showHiddenFiles'] });
    if (selected.canceled) return false;
    const file = selected.filePaths[0];
    const info = await stat(file);
    if (!info.isFile() || info.size > 65_536) throw new Error('请选择有效的 .env 配置文件');
    const env = parse(await readFile(file));
    const connection = checkedForm(formFromEnv(env));
    const config = service.config(connection);
    if (!env.FEISHU_APP_SECRET?.trim()) throw new Error('配置文件缺少 App Secret');
    await service.stop();
    try {
      await service.importSecret(config, env.FEISHU_APP_SECRET.trim());
      prefs.save({ connection });
    } finally { await service.start(form(), bootstrap()); }
    return true;
  }));
  register('appearance', (_win, value) => {
    const { opacity, autostart, indentTodoPriorities } = (value ?? {}) as Appearance;
    if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < .55 || opacity > 1
      || typeof autostart !== 'boolean' || typeof indentTodoPriorities !== 'boolean') throw new Error('外观设置无效');
    const changedAutostart = prefs.value.appearance.autostart !== autostart;
    prefs.save({ appearance: { ...prefs.value.appearance, opacity, autostart, indentTodoPriorities } });
    if (app.isPackaged && !smokeDir && changedAutostart) app.setLoginItemSettings({ openAtLogin: autostart });
    for (const [kind, win] of windows) if (kind !== 'settings') win.setOpacity(opacity);
    broadcast();
  });
  register('theme', (_win, theme) => {
    if (!isTheme(theme)) throw new Error('配色无效');
    prefs.save({ appearance: { ...prefs.value.appearance, theme } });
    for (const win of windows.values()) if (!win.isDestroyed()) win.setBackgroundColor(themes[theme].canvas);
    broadcast();
  });
  register('authorize', () => runExclusive(() => service.authorize(form(), bootstrap(), url => shell.openExternal(url.href))));
  register('show', (_win, kind) => {
    if (kind !== 'schedule' && kind !== 'todo' && kind !== 'settings') throw new Error('窗口类型无效');
    show(kind);
  });
  register('mode', (_win, mode) => {
    if (mode !== 'browse' && mode !== 'edit') throw new Error('窗口模式无效');
    changeMode(mode);
  });
  register('minimize', win => win.minimize());
  register('hide', win => win.close());
  register('reset-layout', () => {
    prefs.save({ layout: {} });
    for (const kind of ['schedule', 'todo'] as const) windows.get(kind)?.setBounds(fit(suggested(kind), kind));
  });
}

async function verifyDesktop(directory: string) {
  const { verify } = await import('./verify.mts');
  for (const kind of ['schedule', 'todo', 'settings'] as const) openWindow(kind);
  await verify(directory, windows);
  app.quit();
}
