import { addDays, validDate } from '../../feishu/dates.mts';
import type { TaskItem } from '../contract.mts';

const dayMs = 86_400_000;
export const offset = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / dayMs);
export const formatDay = (value: string) => Number(value.slice(8, 10));
export const monthStart = (value: string) => value.slice(0, 7) + '-01';
export const monthLabel = (value: string) => value.slice(0, 4) + '年' + Number(value.slice(5, 7)) + '月';
export const dayLabel = (value: string) => Number(value.slice(5, 7)) + '月' + formatDay(value) + '日';
export const weekDay = (value: string) => new Date(value + 'T00:00:00Z').getUTCDay();
export const firstOfWeek = (value: string) => addDays(value, -((weekDay(value) + 6) % 7));

export function moveMonth(day: string, delta: number) {
  const date = new Date(monthStart(day) + 'T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 10);
}

export function monthWeeks(month: string) {
  const first = firstOfWeek(monthStart(month));
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(first, week * 7 + day)));
}

export function hasRange(task: TaskItem): task is TaskItem & {start: string; end: string} {
  return validDate(task.start) && validDate(task.end) && task.end >= task.start && !task.cancelled;
}

export function weekBars(tasks: TaskItem[], days: string[]) {
  const positioned = tasks.filter(hasRange).filter(task => task.start <= days[6] && task.end >= days[0])
    .map(task => ({ task, left: Math.max(0, offset(days[0], task.start)),
      right: Math.min(6, offset(days[0], task.end)) }))
    .sort((a, b) => a.left - b.left || b.right - a.right || a.task.title.localeCompare(b.task.title, 'zh-CN'));
  const lanes: number[] = [];
  return positioned.map(bar => {
    let lane = lanes.findIndex(last => last < bar.left);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = bar.right;
    return { ...bar, lane };
  });
}

export function changeRange(task: {start: string; end: string}, anchor: string, point: string,
  kind: 'move' | 'start' | 'end') {
  const delta = offset(anchor, point);
  if (kind === 'move') return { start: addDays(task.start, delta), end: addDays(task.end, delta) };
  if (kind === 'start') {
    const start = addDays(task.start, delta);
    return { start: start > task.end ? task.end : start, end: task.end };
  }
  const end = addDays(task.end, delta);
  return { start: task.start, end: end < task.start ? task.start : end };
}

export function taskTone(task: TaskItem) {
  if (task.cancelled || /完成|结束/.test(task.status ?? '')) return 'done';
  if (task.failed) return 'rose';
  const category = task.category || task.status || '一般';
  let hash = 0;
  for (const letter of category) hash = (hash + (letter.codePointAt(0) ?? 0) * 31) % 5;
  return ['blue', 'teal', 'violet', 'amber', 'rose'][hash];
}
