import { validDate } from '../feishu/dates.mts';
import type { TaskCommand, TodoCommand } from '../sync/types.mts';

const taskFields = ['title', 'start', 'end', 'notes', 'status', 'category', 'priority', 'progress'];
const todoFields = ['title', 'date', 'done', 'notes', 'priority'];

export function taskCommand(input: unknown): TaskCommand { return checked(input, taskFields, true) as TaskCommand; }
export function todoCommand(input: unknown): TodoCommand { return checked(input, todoFields, false) as TodoCommand; }

function checked(input: unknown, fields: string[], task: boolean) {
  const value = object(input);
  const kind = value.kind;
  if (kind !== 'create' && kind !== 'update' && kind !== 'delete') throw new Error('操作类型无效');
  const id = kind === 'create' ? undefined : recordId(value.id);
  if (kind === 'delete') return { kind, id };
  const clean = Object.fromEntries(Object.entries(object(value.values)).map(([key, field]) => {
    if (!fields.includes(key)) throw new Error('字段不可编辑');
    if (['start', 'end', 'date'].includes(key)) {
      if (field !== null && !validDate(field)) throw new Error('请输入有效日期');
    } else if (key === 'done') {
      if (typeof field !== 'boolean') throw new Error('完成状态无效');
    } else if (key === 'progress') {
      if (field !== null && (typeof field !== 'number' || !Number.isFinite(field) || field < 0 || field > 100)) {
        throw new Error('进度须在 0–100 之间');
      }
    } else {
      const max = key === 'notes' ? 8000 : key === 'title' ? 250 : 120;
      if (typeof field !== 'string' || field.length > max) throw new Error('文字超出允许长度');
      if (key === 'title' && !field.trim()) throw new Error('请输入名称');
    }
    return [key, typeof field === 'string' && key !== 'notes' ? field.trim() : field];
  }));
  if (kind === 'create') {
    if (!clean.title) throw new Error('请输入名称');
    if (task) return { kind, values: { start: null, end: null, notes: '', ...clean } };
    if (!clean.date) throw new Error('请选择待办日期');
    return { kind, values: { done: false, ...clean } };
  }
  if (!Object.keys(clean).length) throw new Error('没有需要保存的修改');
  return { kind, id, values: clean };
}

export function recordId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new Error('记录尚未写入飞书，请稍候');
  }
  return value;
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('操作格式无效');
  return input as Record<string, unknown>;
}
