import { readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Rectangle } from 'electron';
import { defaultTheme, isTheme } from './contract.mts';
import type { Appearance, ConnectionForm, Widget } from './contract.mts';

type Preferences = {
  connection?: ConnectionForm;
  appearance: Appearance;
  layout: Partial<Record<Widget, Rectangle>>;
};

export class PreferencesFile {
  value: Preferences = {
    appearance: { opacity: 1, autostart: false, theme: defaultTheme, indentTodoPriorities: true },
    layout: {},
  };
  #path: string;

  constructor(path: string) {
    this.#path = path;
    try {
      const { connection, appearance, layout } = JSON.parse(readFileSync(path, 'utf8'));
      this.value = {
        connection, layout: layout ?? {},
        appearance: {
          ...this.value.appearance, ...appearance,
          theme: isTheme(appearance?.theme) ? appearance.theme : defaultTheme,
          indentTodoPriorities: appearance?.indentTodoPriorities !== false,
        },
      };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取桌面设置'); }
  }

  save(change: Partial<Preferences>) {
    const value = { ...this.value, ...change };
    const temporary = this.#path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', flush: true });
      renameSync(temporary, this.#path);
      this.value = value;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export function formFromEnv(env: NodeJS.ProcessEnv): ConnectionForm {
  return {
    appId: env.FEISHU_APP_ID ?? '', base: env.FEISHU_BASE_APP_TOKEN ?? '',
    scheduleTable: env.FEISHU_SCHEDULE_TABLE_ID ?? '', todoTable: env.FEISHU_TODO_TABLE_ID ?? '',
    calendar: env.FEISHU_CALENDAR_ID ?? '', zone: env.FEISHU_TIMEZONE ?? 'Asia/Shanghai',
    seconds: env.FEISHU_POLL_SECONDS ?? '300', websocket: env.FEISHU_WEBSOCKET !== '0',
    scheduleFields: env.FEISHU_SCHEDULE_FIELDS ?? '', todoFields: env.FEISHU_TODO_FIELDS ?? '',
    cancelled: env.FEISHU_CANCELLED_STATES ?? '', redirect: env.FEISHU_OAUTH_REDIRECT ?? 'http://127.0.0.1:8765/oauth/callback',
  };
}

export function envFromForm(form: ConnectionForm, directory: string): NodeJS.ProcessEnv {
  return {
    FEISHU_APP_ID: form.appId, FEISHU_BASE_APP_TOKEN: form.base, FEISHU_SCHEDULE_TABLE_ID: form.scheduleTable,
    FEISHU_TODO_TABLE_ID: form.todoTable, FEISHU_CALENDAR_ID: form.calendar, FEISHU_TIMEZONE: form.zone,
    FEISHU_POLL_SECONDS: form.seconds, FEISHU_WEBSOCKET: form.websocket ? '1' : '0',
    FEISHU_SCHEDULE_FIELDS: form.scheduleFields, FEISHU_TODO_FIELDS: form.todoFields,
    FEISHU_CANCELLED_STATES: form.cancelled || undefined, FEISHU_OAUTH_REDIRECT: form.redirect,
    FEISHU_DATA_DIR: directory,
  };
}

export function checkedForm(input: unknown): ConnectionForm {
  if (!input || typeof input !== 'object') throw new Error('配置格式无效');
  const form = formFromEnv({});
  for (const key of Object.keys(form) as (keyof ConnectionForm)[]) {
    const value = (input as Record<string, unknown>)[key];
    if (key === 'websocket') {
      if (typeof value !== 'boolean') throw new Error('长连接设置无效');
      form.websocket = value;
    } else {
      if (typeof value !== 'string' || value.length > 8000) throw new Error('配置格式无效');
      form[key] = value.trim();
    }
  }
  if (!/^cli_[a-z0-9]+$/i.test(form.appId)) throw new Error('请输入有效的飞书 App ID');
  let callback: URL;
  try { callback = new URL(form.redirect); } catch { throw new Error('授权回调地址无效'); }
  if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port
    || callback.username || callback.password || callback.search || callback.hash) {
    throw new Error('授权回调须为带端口的本地 127.0.0.1 地址');
  }
  return form;
}
