import { randomUUID } from 'node:crypto';
import type { Store } from '../storage/store.mts';
import { isScheduled, shared, sharedFields } from './types.mts';
import type { CalendarEvent, EditCommand, Mapping, Remote, Shared, Task, TaskCommand, TaskValues, Todo, TodoCommand } from './types.mts';

type Records = { tasks: Task; todos: Todo };
type Values = { tasks: TaskValues; todos: Omit<Todo, 'id'> };
type Writer<V, R> = {
  create(values: V, key: string): Promise<R>;
  update(id: string, values: Partial<V>): Promise<void>;
  delete(id: string): Promise<void>;
  project?(item: R): R;
};

export class SyncEngine {
  #remote: Remote;
  #store: Store;
  #active?: Promise<void>;
  #onLinking?: (count: number) => void;

  constructor(remote: Remote, store: Store, onLinking?: (count: number) => void) {
    this.#remote = remote;
    this.#store = store;
    this.#onLinking = onLinking;
  }

  snapshot() {
    return {
      tasks: this.#store.get('tasks') ?? [],
      todos: this.#store.get('todos') ?? [],
      pendingTodos: this.#store.pending('todos').length,
      conflicts: this.#store.conflicts(),
    };
  }

  sync(): Promise<void> {
    this.#active ??= this.#sync().finally(() => { this.#active = undefined; });
    return this.#active;
  }

  enqueueTodo(command: TodoCommand): string {
    const id = randomUUID();
    this.#store.enqueue('todos', id, command);
    return id;
  }

  enqueueTask(command: TaskCommand): string {
    const id = randomUUID();
    this.#store.enqueue('tasks', id, command);
    return id;
  }

  orderTodos(ids: string[]) {
    const todos = new Map(this.desktopSnapshot().todos.map(todo => [todo.id, todo]));
    const entries = ids.flatMap((id, index) => {
      const item = todos.get(id);
      if (!item || item.done) throw new Error('待办列表已更新，请重新排序');
      const order = (index + 1) * 1000;
      return item.order === order ? [] : [{
        id: randomUUID(), command: { kind: 'update' as const, id, values: { order } },
      }];
    });
    this.#store.enqueueBatch('todos', entries);
  }

  retryPending() { this.#store.retry(); }

  nextPendingDelay() {
    const deferred = [...this.#store.pending('tasks'), ...this.#store.pending('todos')]
      .filter(entry => entry.nextAt > Date.now());
    return deferred.length ? Math.max(100, Math.min(...deferred.map(entry => entry.nextAt)) - Date.now())
      : undefined;
  }

  desktopSnapshot() {
    const { tasks, todos, conflicts } = this.snapshot();
    const taskQueue = this.#store.pending('tasks');
    const todoQueue = this.#store.pending('todos');
    return {
      tasks: pendingView<TaskValues, Task>(tasks, taskQueue,
        (values, id) => this.#projectTask({ ...values, id }), task => this.#projectTask(task)),
      todos: pendingView<Omit<Todo, 'id'>, Todo>(todos, todoQueue, (values, id) => ({ ...values, id })),
      pendingTasks: taskQueue.length, pendingTodos: todoQueue.length, conflicts,
    };
  }

  async #sync() {
    const results = await Promise.allSettled([this.#syncSchedule(), this.#syncTodos()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, '排期及待办同步失败');
  }

  async #syncTodos() {
    const { errors } = await this.#drain('todos', await this.#remote.listTodos(), {
      create: (values, key) => this.#remote.createTodo(values, key),
      update: (id, values) => this.#remote.updateTodo(id, values),
      delete: id => this.#remote.deleteTodo(id),
    });
    if (errors.length) throw new AggregateError(errors, '部分待办未写入 Base');
  }

  #projectTask(task: Task): Task {
    return { ...task, cancelled: this.#remote.isCancelledStatus?.(task.status)
      ?? (task.status ? ['取消', '已取消'].includes(task.status) : task.cancelled) };
  }

  async #drain<K extends keyof Records>(bucket: K, rows: Records[K][], writer: Writer<Values[K], Records[K]>) {
    const records = new Map(rows.map(row => [row.id, row]));
    this.#store.putRecords(bucket, rows);
    const blocked = new Set<string>();
    const errors: unknown[] = [];
    for (const pending of this.#store.pending(bucket)) {
      const command = pending.command as EditCommand<Values[K]>;
      const target = 'id' in command ? command.id : pending.id;
      if (pending.nextAt > Date.now() || blocked.has(target)) {
        blocked.add(target);
        continue;
      }
      try {
        await applyCommand(records, writer, command, pending.id);
        this.#store.complete(bucket, pending.id, [...records.values()]);
      } catch (error) {
        const delay = Math.min(300_000, 1_000 * 2 ** Math.min(pending.attempts, 9));
        this.#store.defer(bucket, pending.id, pending.attempts + 1, Date.now() + delay);
        blocked.add(target);
        errors.push(error);
      }
    }
    return { rows: [...records.values()], errors };
  }

  async #syncSchedule() {
    const { rows: tasks, errors } = await this.#drain('tasks', await this.#remote.listTasks(), {
      create: (values, key) => {
        if (!this.#remote.createTask) throw new Error('任务新增不可用');
        return this.#remote.createTask(values, key);
      },
      update: (id, values) => this.#remote.updateTask(id, values),
      delete: id => {
        if (!this.#remote.deleteTask) throw new Error('任务删除不可用');
        return this.#remote.deleteTask(id);
      },
      project: task => this.#projectTask(task),
    });
    const pending = new Set(this.#store.pending('tasks').flatMap(entry =>
      'id' in entry.command ? [entry.command.id] : []));
    const cursor = this.#store.get('cursor') ?? undefined;
    const { events, cursor: nextCursor, full } = await this.#remote.listEvents(cursor);
    const byId = new Map(events.map(event => [event.id, event]));
    const mappings = new Map(this.#store.mappings().map(mapping => [mapping.recordId, mapping]));
    const identified = new Map<string, CalendarEvent>();
    for (const event of events) {
      if (!event.recordId || event.deleted) continue;
      const known = identified.get(event.recordId);
      if (known && known.id !== event.id) throw new Error('同一任务匹配多个日程，请核对映射');
      identified.set(event.recordId, event);
    }
    const links = new Set<string>();
    for (const task of tasks) {
      if (pending.has(task.id)) continue;
      if (!task.linkedCalendar || !task.eventId) continue;
      if (links.has(task.eventId)) throw new Error('多个任务指向同一日程，请核对 Base 映射');
      links.add(task.eventId);
    }
    const present = new Set(tasks.map(task => task.id));
    const linksToWrite = new Map<Task, string>();
    for (const task of tasks) {
      const mapping = mappings.get(task.id);
      if (mapping?.eventId && !mapping.retired) {
        if (!isScheduled(task)) {
          await this.#retire(mapping);
          if (task.eventId) linksToWrite.set(task, '');
        } else {
          const unchanged: CalendarEvent | undefined = cursor && nextCursor && !full && mapping.last
            ? { ...mapping.last, id: mapping.eventId } : undefined;
          const event = byId.get(mapping.eventId) ?? unchanged ?? await this.#remote.getEvent(mapping.eventId);
          if (event && !event.deleted) await this.#merge(task, event, mapping, linksToWrite);
          else await this.#clearDates(task, mapping);
        }
      } else if (isScheduled(task)) {
        const found = mapping?.retired ? undefined : identified.get(task.id);
        await this.#create(task, linksToWrite, mapping?.retired ? undefined : mapping, found);
      } else {
        const found = identified.get(task.id);
        if (mapping && !mapping.retired || found) {
          await this.#retire(mapping ?? { recordId: task.id, key: randomUUID() }, found);
        }
        if (task.eventId) linksToWrite.set(task, '');
      }
    }
    for (const mapping of mappings.values()) {
      if (!mapping.retired && !present.has(mapping.recordId)) {
        await this.#retire(mapping, identified.get(mapping.recordId));
      }
    }
    await this.#writeLinks(linksToWrite);
    this.#store.put('tasks', tasks);
    if (!pending.size) this.#store.put('cursor', nextCursor ?? null);
    if (errors.length) throw new AggregateError(errors, '部分任务未写入 Base');
  }

  async #writeLinks(links: Map<Task, string>) {
    if (!links.size || (!this.#remote.linkTasks && !this.#remote.linkTask)) return;
    this.#onLinking?.(links.size);
    if (this.#remote.linkTasks) {
      const saved = await this.#remote.linkTasks([...links].map(([task, eventId]) => ({ id: task.id, eventId })));
      if (saved) for (const [task, eventId] of links) task.eventId = eventId || undefined;
      return;
    }
    for (const [task, eventId] of links) {
      if (await this.#remote.linkTask?.(task.id, eventId)) task.eventId = eventId || undefined;
    }
  }

  async #create(task: Task, links: Map<Task, string>, existing?: Mapping, found?: CalendarEvent) {
    const mapping = existing ?? { recordId: task.id, key: randomUUID(), createValues: shared(task) };
    const linked = !existing && !found && task.eventId ? await this.#remote.getEvent(task.eventId) : null;
    if (!existing && !found && task.eventId && task.linkedCalendar && (!linked || linked.deleted)) {
      await this.#clearDates(task, { ...mapping, eventId: task.eventId });
      return;
    }
    const verified = linked && !linked.deleted && (linked.recordId === task.id
      || !linked.recordId && task.linkedCalendar) ? linked : undefined;
    const recovered = found ?? verified
      ?? (existing ? await this.#remote.findEvent?.(task.id) : undefined);
    this.#store.saveMapping(mapping);
    const event = recovered ?? await this.#remote.createEvent(
      task.id, mapping.createValues ?? shared(task), mapping.key,
    );
    if (event.deleted) throw new Error('已删除日程不能作为创建结果');
    mapping.eventId = event.id;
    this.#store.saveMapping(mapping);
    await this.#merge(task, event, mapping, links);
  }

  async #clearDates(task: Task, mapping: Mapping) {
    const patch = { start: null, end: null, ...(task.eventId ? { eventId: '' } : {}) };
    await this.#remote.updateTask(task.id, patch);
    Object.assign(task, patch);
    this.#store.saveMapping({ ...mapping, retired: true });
  }

  async #retire(mapping: Mapping, discovered?: CalendarEvent) {
    const eventId = mapping.eventId ?? discovered?.id
      ?? (await this.#remote.findEvent?.(mapping.recordId))?.id;
    if (eventId) await this.#remote.deleteEvent(eventId);
    this.#store.saveMapping({ ...mapping, retired: true });
  }

  async #merge(task: Task, event: CalendarEvent, mapping: Mapping, links: Map<Task, string>) {
    const merged = shared(task);
    const conflict: string[] = [];
    for (const field of sharedFields) {
      if (!mapping.last || event[field] === task[field] || event[field] === mapping.last[field]) {
        continue;
      }
      if (task[field] === mapping.last[field]) Object.assign(merged, { [field]: event[field] });
      else conflict.push(field);
    }
    if (!isScheduled(merged)) {
      merged.start = task.start;
      merged.end = task.end;
      conflict.push('date_range');
    }
    const basePatch = changes(task, merged);
    const calendarPatch = changes(event, merged);
    if (task.notesWritable === false) {
      delete basePatch.notes;
      delete calendarPatch.notes;
    }
    if (calendarPatch.start || calendarPatch.end) {
      calendarPatch.start = merged.start;
      calendarPatch.end = merged.end;
    }
    if (Object.keys(basePatch).length) {
      await this.#remote.updateTask(task.id, basePatch);
      Object.assign(task, basePatch);
    }
    if (Object.keys(calendarPatch).length) {
      await this.#remote.updateEvent(event.id, task.id, calendarPatch);
    }
    if (task.eventId !== event.id) links.set(task, event.id);
    for (const field of conflict) this.#store.conflict(task.id, field);
    this.#store.saveMapping({ recordId: mapping.recordId, key: mapping.key, eventId: event.id, last: merged });
  }
}

async function applyCommand<V, R extends { id: string }>(
  records: Map<string, R>, writer: Writer<V, R>, command: EditCommand<V>, key: string,
) {
  if (command.kind === 'create') {
    const item = await writer.create(command.values, key);
    records.set(item.id, item);
    return;
  }
  const current = records.get(command.id);
  if (command.kind === 'delete') {
    if (current) await writer.delete(command.id);
    records.delete(command.id);
    return;
  }
  if (!current) throw new Error('需要修改的飞书记录已不存在');
  if (Object.entries(command.values as object).some(([key, value]) => current[key as keyof R] !== value)) {
    await writer.update(command.id, command.values);
    const updated = { ...current, ...command.values };
    records.set(command.id, writer.project ? writer.project(updated) : updated);
  }
}

function pendingView<V, R extends { id: string }>(
  rows: R[], queue: {id: string; command: EditCommand<V>; attempts: number}[],
  create: (values: V, id: string) => R, project?: (row: R) => R,
) {
  const result = new Map<string, R & { pending?: boolean; failed?: boolean }>(
    rows.map(row => [row.id, row]),
  );
  for (const { id, command, attempts } of queue) {
    const target = command.kind === 'create' ? 'local:' + id : command.id;
    if (command.kind === 'delete') { result.delete(target); continue; }
    const original = result.get(target);
    const item = command.kind === 'create' ? create(command.values, target)
      : original ? { ...original, ...command.values } : undefined;
    if (!item) continue;
    result.set(target, { ...(project ? project(item) : item), pending: true, failed: attempts > 0 });
  }
  return [...result.values()];
}

function changes(from: Shared, to: Shared): Partial<Shared> {
  return Object.fromEntries(sharedFields.filter(field => from[field] !== to[field])
    .map(field => [field, to[field]]));
}
