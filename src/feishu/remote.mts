import { createHash } from 'node:crypto';
import { addDays, Dates, validDate } from './dates.mts';
import { FeishuError } from './http.mts';
import type { Api } from './http.mts';
import type { CalendarEvent, Remote, Shared, Task, TaskLink, TaskValues, Todo } from '../sync/types.mts';

type Fields = Record<string, string | undefined>;
type CellValues = Record<string, unknown>;
type BaseRecord = { record_id: string; fields: CellValues };
type BaseField = { field_name: string; type: number; property?: {options?: {name: string}[]} };
type Page<T> = { items?: T[]; has_more?: boolean; page_token?: string; sync_token?: string };
type EventTime = { date?: string; timestamp?: string };
type RawEvent = {
  event_id: string; summary?: string; description?: string; status?: string;
  start_time?: EventTime; end_time?: EventTime;
};
type Config = {
  base: string; scheduleTable: string; todoTable: string; calendar: string; zone: string;
  scheduleFields?: Fields; todoFields?: Fields; cancelled?: string[];
  requireSharedCalendar?: boolean;
};

const scheduleDefaults = {
  title: '任务名称', start: '任务开始日期', end: '任务截止日期', status: '状态',
  notes: '任务详情', eventId: '日程ID', calendarId: '日历ID',
  category: '任务类别', priority: '优先级', progress: '进度',
};
const todoDefaults = { title: '待办事项', date: '计划日期', done: '完成',
  order: '排序权重', priority: '优先级', notes: '备注' };
const expectedTypes: Record<string, number[]> = {
  title: [1], start: [5], end: [5], date: [5], status: [1, 3], notes: [1],
  eventId: [1], calendarId: [1], done: [7], order: [2], progress: [2],
  category: [1, 3], priority: [1, 3],
};

export class FeishuRemote implements Remote {
  #api: Api;
  #config: Config;
  #dates: Dates;
  #resource: string;
  #recordIds = new Map<string, string>();
  #schemas = new Map<string, Promise<Fields>>();
  #columns = new Map<string, BaseField[]>();
  #calendarCheck?: Promise<void>;

  constructor(api: Api, config: Config) {
    this.#api = api;
    this.#config = config;
    this.#dates = new Dates(config.zone);
    this.#resource = JSON.stringify([config.base, config.scheduleTable, config.calendar]);
  }

  #table(table: string) {
    return `bitable/v1/apps/${encodeURIComponent(this.#config.base)}/tables/${encodeURIComponent(table)}`;
  }

  #calendar() { return 'calendar/v4/calendars/' + encodeURIComponent(this.#config.calendar); }

  #events() { return this.#calendar() + '/events'; }

  async #records(table: string, fields: Fields) {
    return collect<BaseRecord>(page_token => this.#api('tenant', this.#table(table) + '/records/search', {
      method: 'POST', query: { page_size: 500, page_token },
      body: { field_names: Object.values(fields) },
    }));
  }

  #schema(kind: 'schedule' | 'todo'): Promise<Fields> {
    const cached = this.#schemas.get(kind);
    if (cached) return cached;
    const schema = this.#loadSchema(kind).catch(error => { this.#schemas.delete(kind); throw error; });
    this.#schemas.set(kind, schema);
    return schema;
  }

  async #loadSchema(kind: 'schedule' | 'todo'): Promise<Fields> {
    const schedule = kind === 'schedule';
    const table = schedule ? this.#config.scheduleTable : this.#config.todoTable;
    const overrides = (schedule ? this.#config.scheduleFields : this.#config.todoFields) ?? {};
    const defaults = schedule ? scheduleDefaults : todoDefaults;
    const required = schedule ? ['title', 'start', 'end', 'status'] : ['title', 'date', 'done'];
    const items = await collect<BaseField>(page_token => this.#api('tenant', this.#table(table) + '/fields', {
      query: { page_size: 100, page_token },
    }));
    this.#columns.set(kind, items);
    const known = new Map(items.map(field => [field.field_name, field.type]));
    const fields: Fields = {};
    for (const [key, name] of Object.entries({ ...defaults, ...overrides })) {
      if (name && expectedTypes[key]?.includes(known.get(name) ?? -1)) fields[key] = name;
      else if (required.includes(key) || overrides[key]) {
        throw new Error(`Base ${kind} 字段 ${key} 缺失或类型不匹配，请核对字段映射`);
      }
    }
    return fields;
  }

  async capabilities() {
    const result = await Promise.allSettled([this.#schema('schedule'), this.#schema('todo')]);
    const schedule = result[0].status === 'fulfilled' ? result[0].value : {};
    const todo = result[1].status === 'fulfilled' ? result[1].value : {};
    const options = (kind: string, field?: string) => this.#columns.get(kind)
      ?.find(column => column.field_name === field)?.property?.options?.map(option => option.name) ?? [];
    const status = options('schedule', schedule.status);
    return {
      task: Object.keys(schedule), todo: Object.keys(todo),
      status,
      categories: options('schedule', schedule.category),
      taskPriority: options('schedule', schedule.priority),
      todoPriority: options('todo', todo.priority),
      cancelStatus: status.find(value => this.isCancelledStatus(value)) ?? this.#config.cancelled?.[0] ?? '已取消',
    };
  }

  async inspect() {
    const [schedule, todo, calendar] = await Promise.allSettled([
      this.#schema('schedule'),
      this.#schema('todo'),
      this.#api<{ type?: string; role?: string }>('user', this.#calendar()),
    ]);
    return {
      schedule: schedule.status === 'fulfilled' ? schedule.value : errorText(schedule.reason),
      todo: todo.status === 'fulfilled' ? todo.value : errorText(todo.reason),
      calendar: calendar.status === 'fulfilled' ? {
        type: calendar.value?.type, role: calendar.value?.role,
      } : errorText(calendar.reason),
      ok: schedule.status === 'fulfilled' && todo.status === 'fulfilled'
        && calendar.status === 'fulfilled' && calendar.value?.type === 'shared'
        && ['writer', 'owner'].includes(calendar.value.role ?? ''),
    };
  }

  async listTasks(): Promise<Task[]> {
    const schema = await this.#schema('schedule');
    const records = await this.#records(this.#config.scheduleTable, schema);
    this.#recordIds.clear();
    return records.map(record => this.#task(record, schema));
  }

  isCancelledStatus(status = '') {
    return (this.#config.cancelled ?? ['取消', '已取消']).includes(status);
  }

  #task({ record_id: id, fields }: BaseRecord, schema: Fields): Task {
    this.#remember(id);
    const status = readText(cell(fields, schema.status));
    const calendar = readText(cell(fields, schema.calendarId));
    const eventId = !calendar || calendar === this.#config.calendar
      ? readText(cell(fields, schema.eventId)) : '';
    const progress = cell(fields, schema.progress);
    return {
      id, title: readText(cell(fields, schema.title)), notes: readText(cell(fields, schema.notes)),
      start: this.#dates.day(cell(fields, schema.start)), end: this.#dates.day(cell(fields, schema.end)),
      status, cancelled: this.isCancelledStatus(status),
      eventId: eventId || undefined, linkedCalendar: calendar === this.#config.calendar,
      notesWritable: Boolean(schema.notes),
      category: schema.category ? readText(cell(fields, schema.category)) : undefined,
      priority: schema.priority ? readText(cell(fields, schema.priority)) : undefined,
      progress: typeof progress === 'number' ? progress : undefined,
    };
  }

  async listTodos(): Promise<Todo[]> {
    const schema = await this.#schema('todo');
    return (await this.#records(this.#config.todoTable, schema))
      .map(record => this.#todo(record, schema));
  }

  #todo({ record_id: id, fields }: BaseRecord, schema: Fields): Todo {
    const order = cell(fields, schema.order);
    return {
      id, title: readText(cell(fields, schema.title)), date: this.#dates.day(cell(fields, schema.date)),
      done: cell(fields, schema.done) === true,
      order: typeof order === 'number' ? order : undefined,
      notes: schema.notes ? readText(cell(fields, schema.notes)) : undefined,
      priority: schema.priority ? readText(cell(fields, schema.priority)) : undefined,
    };
  }

  #cells(values: object, schema: Fields, optional: string[] = []): CellValues {
    const result: CellValues = {};
    for (const [key, value] of Object.entries(values)) {
      if (!schema[key]) {
        if (optional.includes(key)) continue;
        throw new Error(`Base 未配置可写字段 ${key}`);
      }
      const isDate = key === 'start' || key === 'end' || key === 'date';
      result[schema[key]] = isDate ? this.#dates.midnight(value) : value;
    }
    return result;
  }

  async updateTask(id: string, patch: Partial<TaskValues> & { eventId?: string }) {
    const schema = await this.#schema('schedule');
    const values = patch.eventId === undefined ? patch : {
      ...patch, calendarId: patch.eventId ? this.#config.calendar : '',
    };
    const fields = this.#cells(values, schema, ['eventId', 'calendarId']);
    if (Object.keys(fields).length) await this.#update(this.#config.scheduleTable, id, fields);
  }

  async createTask(values: TaskValues, key: string) {
    const schema = await this.#schema('schedule');
    const record = await this.#createRecord(this.#config.scheduleTable, this.#cells(values, schema, ['notes']), key);
    return this.#task(record, schema);
  }

  async deleteTask(id: string) { await this.#deleteRecord(this.#config.scheduleTable, id); }

  async linkTask(id: string, eventId: string) {
    const schema = await this.#schema('schedule');
    if (!schema.eventId) return false;
    await this.updateTask(id, { eventId });
    return true;
  }

  async linkTasks(links: TaskLink[]) {
    const schema = await this.#schema('schedule');
    if (!schema.eventId) return false;
    if (links.length === 1) return this.linkTask(links[0].id, links[0].eventId);
    for (let index = 0; index < links.length; index += 100) {
      const records = links.slice(index, index + 100).map(({ id, eventId }) => ({
        record_id: id,
        fields: this.#cells({ eventId: eventId || null, calendarId: eventId ? this.#config.calendar : null },
          schema, ['calendarId']),
      }));
      const path = this.#table(this.#config.scheduleTable) + '/records/batch_update';
      const result = await this.#api<{ records?: { record_id: string }[] }>('tenant', path,
        { method: 'POST', body: { records } });
      const saved = new Set(result?.records?.map(record => record.record_id));
      if (records.some(record => !saved.has(record.record_id))) throw new Error('飞书未确认全部日程关联');
    }
    return true;
  }

  async createTodo(values: Omit<Todo, 'id'>, key: string): Promise<Todo> {
    const schema = await this.#todoSchema(values);
    const fields = this.#cells(values, schema);
    return this.#todo(await this.#createRecord(this.#config.todoTable, fields, key), schema);
  }

  async #createRecord(table: string, fields: CellValues, key: string) {
    const data = await this.#api<{ record: BaseRecord }>(
      'tenant', this.#table(table) + '/records', {
        method: 'POST', query: { client_token: key }, body: { fields },
      });
    if (!data?.record?.record_id) throw new Error('飞书未返回新增记录');
    return data.record;
  }

  async updateTodo(id: string, values: Partial<Omit<Todo, 'id'>>) {
    const schema = await this.#todoSchema(values);
    await this.#update(this.#config.todoTable, id, this.#cells(values, schema));
  }

  async #todoSchema(values: Partial<Omit<Todo, 'id'>>) {
    const schema = await this.#schema('todo');
    if (values.order === undefined || schema.order) return schema;
    const field = todoDefaults.order;
    if (this.#columns.get('todo')?.some(column => column.field_name === field)) {
      throw new Error('待办排序权重列须为数字类型，请在配置中指定可写列');
    }
    try {
      await this.#api('tenant', this.#table(this.#config.todoTable) + '/fields', {
        method: 'POST', body: { field_name: field, type: 2 },
      });
    } finally {
      this.#schemas.delete('todo');
    }
    return this.#schema('todo');
  }

  async #update(table: string, id: string, fields: CellValues) {
    await this.#api('tenant', this.#table(table) + '/records/' + encodeURIComponent(id),
      { method: 'PUT', body: { fields } });
  }

  async deleteTodo(id: string) {
    await this.#deleteRecord(this.#config.todoTable, id);
  }

  async #deleteRecord(table: string, id: string) {
    try {
      await this.#api('tenant', this.#table(table) + '/records/' + encodeURIComponent(id),
        { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof FeishuError) || error.code !== 1254043) throw error;
    }
  }

  #event(event: RawEvent): CalendarEvent {
    const { start_time: start, end_time: end } = event;
    const description = event.description ?? '';
    const marker = /(?:^|\n\n)\[计划管理器:([a-f0-9]{40})\]$/.exec(description);
    return {
      id: event.event_id,
      recordId: marker ? this.#recordIds.get(marker[1]) : undefined,
      deleted: event.status === 'cancelled',
      title: event.summary ?? '',
      notes: marker && this.#recordIds.has(marker[1]) ? description.slice(0, marker.index) : description,
      start: validDate(start?.date) ? start.date : this.#eventDay(start),
      end: validDate(end?.date) ? addDays(end.date, -1) : this.#eventDay(end, -1),
    };
  }

  #eventDay(time: EventTime | undefined, delta = 0) {
    return time?.timestamp ? this.#dates.day(Number(time.timestamp) * 1000 + delta) : null;
  }

  #remember(recordId: string) {
    const key = createHash('sha256').update(this.#resource).update(':').update(recordId)
      .digest('hex').slice(0, 40);
    this.#recordIds.set(key, recordId);
    return key;
  }

  #eventPatch(recordId: string, patch: Partial<Shared>) {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.summary = patch.title;
    if (patch.notes !== undefined) {
      const marker = '[计划管理器:' + this.#remember(recordId) + ']';
      body.description = patch.notes ? patch.notes + '\n\n' + marker : marker;
    }
    if (patch.start) body.start_time = { date: patch.start };
    // Calendar v4 accepts an inclusive all-day end date and returns the next day as the boundary.
    if (patch.end) body.end_time = { date: patch.end };
    return body;
  }

  async getEvent(id: string) {
    try {
      const data = await this.#api<{ event: RawEvent }>(
        'user', this.#events() + '/' + encodeURIComponent(id));
      return this.#event(data.event);
    } catch (error) {
      if (isMissingEvent(error)) return null;
      throw error;
    }
  }

  async listEvents(cursor?: string): Promise<{ events: CalendarEvent[]; cursor?: string; full: boolean }> {
    await this.#checkSharedCalendar();
    let nextCursor: string | undefined;
    try {
      const items = await collect<RawEvent>(async page_token => {
        const page = await this.#api<Page<RawEvent>>('user', this.#events(), {
          query: { page_size: 500, page_token, sync_token: cursor,
            anchor_time: cursor ? undefined : '0' },
        });
        nextCursor = page.sync_token ?? nextCursor;
        return page;
      });
      return { events: items.map(event => this.#event(event)), cursor: nextCursor, full: !cursor };
    } catch (error) {
      if (cursor && error instanceof FeishuError && (error.status === 410 || error.code === 190002)) {
        return this.listEvents();
      }
      throw error;
    }
  }

  async findEvent(recordId: string) {
    this.#remember(recordId);
    const matches = (await this.listEvents()).events
      .filter(event => !event.deleted && event.recordId === recordId);
    if (matches.length > 1) throw new Error('同一任务匹配多个日程，请核对映射');
    return matches[0];
  }

  async createEvent(recordId: string, patch: Shared, key: string) {
    await this.#checkSharedCalendar();
    const data = await this.#api<{ event: RawEvent }>('user', this.#events(), {
      method: 'POST', query: { idempotency_key: key },
      body: { ...this.#eventPatch(recordId, patch),
        free_busy_status: 'free', need_notification: false },
    });
    return this.#event(data.event);
  }

  async updateEvent(id: string, recordId: string, patch: Partial<Shared>) {
    await this.#checkSharedCalendar();
    await this.#api('user', this.#events() + '/' + encodeURIComponent(id), {
      method: 'PATCH', body: { ...this.#eventPatch(recordId, patch), need_notification: false },
    });
  }

  async deleteEvent(id: string) {
    await this.#checkSharedCalendar();
    try {
      await this.#api('user', this.#events() + '/' + encodeURIComponent(id),
        { method: 'DELETE', query: { need_notification: 'false' } });
    } catch (error) {
      if (isMissingEvent(error)) return;
      if (error instanceof FeishuError && error.code === 193003) {
        const event = await this.getEvent(id);
        if (!event || event.deleted) return;
      }
      throw error;
    }
  }

  async #checkSharedCalendar() {
    if (!this.#config.requireSharedCalendar) return;
    this.#calendarCheck ??= this.#api<{ type?: string; role?: string }>('user', this.#calendar()).then(calendar => {
      if (calendar.type !== 'shared' || !['owner', 'writer'].includes(calendar.role ?? '')) {
        throw new Error('目标日历须为可编辑的共享日历');
      }
    }).catch(error => {
      this.#calendarCheck = undefined;
      throw error;
    });
    await this.#calendarCheck;
  }
}

async function collect<T>(load: (page?: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let next: string | undefined;
  do {
    const page = await load(next);
    if (!page || (!Array.isArray(page.items) && page.items !== undefined)) {
      throw new Error('飞书分页响应格式异常');
    }
    items.push(...page.items ?? []);
    next = page.has_more === false ? undefined : page.page_token || undefined;
    if (page.has_more && !next || next && seen.has(next)) throw new Error('飞书分页不完整');
    if (next) seen.add(next);
  } while (next);
  return items;
}

function cell(fields: CellValues, name?: string) { return name ? fields[name] : undefined; }

function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => item?.text ?? '').join('');
  return '';
}

function isMissingEvent(error: unknown) {
  return error instanceof FeishuError && (error.status === 404 || error.code === 190014);
}

function errorText(error: unknown) { return error instanceof Error ? error.message : '连接失败'; }
