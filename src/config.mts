import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { config as dotenv } from 'dotenv';
import { Dates } from './feishu/dates.mts';

export function readConfig(input?: NodeJS.ProcessEnv) {
  if (!input) dotenv({ quiet: true });
  const env = input ?? process.env;
  const appId = required(env, 'FEISHU_APP_ID');
  const base = required(env, 'FEISHU_BASE_APP_TOKEN');
  const scheduleTable = required(env, 'FEISHU_SCHEDULE_TABLE_ID');
  const todoTable = required(env, 'FEISHU_TODO_TABLE_ID');
  const calendar = required(env, 'FEISHU_CALENDAR_ID');
  if (scheduleTable === todoTable) throw new Error('Schedule 和 Todo 须指向两张独立的表');
  const zone = env.FEISHU_TIMEZONE || 'Asia/Shanghai';
  new Dates(zone);
  const seconds = Number(env.FEISHU_POLL_SECONDS || '300');
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600) {
    throw new Error('FEISHU_POLL_SECONDS 须为 15–3600 的整数');
  }
  return {
    appId, base, scheduleTable, todoTable, calendar, zone,
    bootstrapSecret: env.FEISHU_APP_SECRET,
    appKey: hash(appId),
    scope: hash(JSON.stringify([appId, base, scheduleTable, todoTable, calendar, zone])),
    directory: resolve(env.FEISHU_DATA_DIR || 'data'),
    interval: seconds * 1000,
    websocket: env.FEISHU_WEBSOCKET !== '0',
    scheduleFields: fieldMap(env.FEISHU_SCHEDULE_FIELDS, 'FEISHU_SCHEDULE_FIELDS'),
    todoFields: fieldMap(env.FEISHU_TODO_FIELDS, 'FEISHU_TODO_FIELDS'),
    cancelled: env.FEISHU_CANCELLED_STATES?.split(',').map(value => value.trim()).filter(Boolean),
    redirect: new URL(env.FEISHU_OAUTH_REDIRECT || 'http://127.0.0.1:8765/oauth/callback'),
    oauthScopes: env.FEISHU_OAUTH_SCOPES || 'calendar:calendar offline_access',
  };
}

function hash(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 32); }

function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`缺少配置 ${key}`);
  return value;
}

function fieldMap(value: string | undefined, name: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
      || !Object.values(parsed).every(field => typeof field === 'string')) throw new Error();
    return parsed as Record<string, string>;
  } catch {
    throw new Error(`${name} 须为字段键对应列名的 JSON 对象`);
  }
}
