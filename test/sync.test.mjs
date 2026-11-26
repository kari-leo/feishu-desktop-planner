import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncEngine } from '../src/sync/engine.mts';
import { Store } from '../src/storage/store.mts';

function fixture(t, path = ':memory:') {
  const tasks = new Map();
  const todos = new Map();
  const events = new Map();
  const keys = new Map();
  const writes = [];
  const remote = {
    async listTasks() { return structuredClone([...tasks.values()]); },
    async listTodos() { return structuredClone([...todos.values()]); },
    async getEvent(id) { return structuredClone(events.get(id) ?? null); },
    async listEvents() { return { events: structuredClone([...events.values()]) }; },
    async createEvent(recordId, data, key) {
      if (keys.has(key)) return this.getEvent(keys.get(key));
      const event = { ...data, id: 'event-' + (keys.size + 1), recordId };
      keys.set(key, event.id);
      events.set(event.id, event);
      writes.push('create-event');
      return structuredClone(event);
    },
    async updateEvent(id, recordId, data) {
      Object.assign(events.get(id), data, { recordId });
      writes.push('update-event');
    },
    async deleteEvent(id) { events.delete(id); writes.push('delete-event'); },
    async updateTask(id, patch) {
      Object.assign(tasks.get(id), patch);
      writes.push('update-task');
    },
    async updateTodo(id, patch) {
      Object.assign(todos.get(id), patch);
      writes.push('update-todo');
    },
  };
  const store = new Store(path, 'test');
  let open = true;
  const close = () => {
    if (open) store.close();
    open = false;
  };
  t.after(close);
  const engine = new SyncEngine(remote, store);
  return { engine, remote, tasks, todos, events, writes, close };
}

const task = { id: 'r1', title: '排期', start: '2026-11-25', end: '2026-11-25', notes: '' };

test('有效任务只创建一个日程，缺失日期的任务保持未排期', async (t) => {
  const { engine, tasks, events, writes } = fixture(t);
  tasks.set(task.id, task);
  tasks.set('r2', { ...task, id: 'r2', end: null });
  await engine.sync();
  await engine.sync();
  assert.deepEqual(writes, ['create-event']);
  assert.equal([...events.values()][0].end, '2026-11-25');
  assert.equal(engine.snapshot().tasks.length, 2);
});

test('离线待办在重启后恢复，飞书改动可读且待办不会创建日程', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'planner-'));
  const db = join(path, 'planner.db');
  const { engine, remote, todos, writes, close } = fixture(t, db);
  todos.set('todo-1', { id: 'todo-1', title: '原事项', date: task.start, done: false });
  await engine.sync();
  engine.enqueueTodo({ kind: 'update', id: 'todo-1', values: { done: true } });
  todos.get('todo-1').title = '飞书改名';
  close();
  const reopened = new Store(db, 'test');
  t.after(() => {
    reopened.close();
    rmSync(path, { recursive: true, force: true });
  });
  const restarted = new SyncEngine(remote, reopened);
  assert.equal(restarted.snapshot().pendingTodos, 1);
  await restarted.sync();
  assert.deepEqual(restarted.snapshot().todos, [
    { id: 'todo-1', title: '飞书改名', date: task.start, done: true },
  ]);
  assert.deepEqual(writes, ['update-todo']);
});

test('两端改期均能传播，跨端不同字段合并，同字段以 Base 为准', async (t) => {
  const { engine, tasks, events, writes } = fixture(t);
  tasks.set(task.id, { ...task });
  await engine.sync();
  tasks.get('r1').title = 'Base 名称';
  Object.assign(events.get('event-1'), { title: '日历名称', end: '2026-12-01' });
  await engine.sync();
  await engine.sync();
  assert.equal(tasks.get('r1').end, '2026-12-01');
  assert.equal(events.get('event-1').title, 'Base 名称');
  assert.deepEqual(writes, ['create-event', 'update-task', 'update-event']);
  assert.equal(engine.snapshot().conflicts, 1);
});

test('删除日历日程会保留任务，重新排期后删除 Base 任务会删除对应日程', async (t) => {
  const { engine, tasks, events, writes } = fixture(t);
  tasks.set(task.id, { ...task });
  await engine.sync();
  events.delete('event-1');
  await engine.sync();
  assert.equal(tasks.get('r1').start, null);
  assert.equal(tasks.get('r1').end, null);
  Object.assign(tasks.get('r1'), { start: task.start, end: task.end });
  await engine.sync();
  tasks.delete('r1');
  await engine.sync();
  await engine.sync();
  assert.deepEqual(writes, ['create-event', 'update-task', 'create-event', 'delete-event']);
  assert.equal(events.size, 0);
});

test('远端创建成功但响应丢失时，即使任务再次编辑也只保留一个日程', async (t) => {
  const { engine, remote, tasks, events, writes } = fixture(t);
  tasks.set(task.id, { ...task });
  const create = remote.createEvent.bind(remote);
  let first = true;
  let original;
  remote.listEvents = async () => ({ events: [] });
  remote.createEvent = async (id, values, key) => {
    if (first) original = structuredClone(values);
    else assert.deepEqual(values, original);
    const result = await create(id, values, key);
    if (first) {
      first = false;
      throw new Error('连接中断');
    }
    return result;
  };
  await assert.rejects(engine.sync(), /连接中断/);
  tasks.get('r1').title = '新名称';
  await engine.sync();
  assert.deepEqual(writes, ['create-event', 'update-event']);
  assert.equal(events.get('event-1').title, '新名称');
});

test('本地映射缺失时，按 Base 日程链接识别已删除的日程', async (t) => {
  const { engine, tasks, events, writes } = fixture(t);
  tasks.set(task.id, { ...task, eventId: 'removed-event', linkedCalendar: true });
  await engine.sync();
  assert.equal(tasks.get('r1').start, null);
  assert.equal(tasks.get('r1').eventId, '');
  assert.equal(events.size, 0);
  assert.deepEqual(writes, ['update-task']);
});

test('桌面新任务先进入本地队列，写入 Base 后才创建日历日程', async (t) => {
  const { engine, remote, tasks, events, writes } = fixture(t);
  remote.createTask = async (values) => {
    const task = { ...values, id: 'from-base' };
    tasks.set(task.id, task);
    writes.push('create-task');
    return task;
  };
  engine.enqueueTask({ kind: 'create', values: { title: '桌面新增', start: task.start,
    end: task.end, notes: '', status: '进行中' } });
  assert.equal(engine.desktopSnapshot().tasks[0]?.title, '桌面新增');
  assert.equal(engine.desktopSnapshot().pendingTasks, 1);
  assert.equal(events.size, 0);
  await engine.sync();
  assert.deepEqual(writes, ['create-task', 'create-event']);
  assert.equal(engine.desktopSnapshot().tasks[0]?.id, 'from-base');
  assert.equal(engine.desktopSnapshot().pendingTasks, 0);
});

test('桌面改期在离线关闭后继续写回，取消任务随后移除日历映射', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'planner-desktop-'));
  const db = join(path, 'planner.db');
  const { engine, remote, tasks, events, close } = fixture(t, db);
  tasks.set(task.id, { ...task, status: '进行中' });
  await engine.sync();
  engine.enqueueTask({ kind: 'update', id: task.id, values: { end: '2026-12-02' } });
  assert.equal(engine.desktopSnapshot().pendingTasks, 1);
  assert.equal([...events.values()][0].end, '2026-11-25');
  close();
  const store = new Store(db, 'test');
  t.after(() => {
    store.close();
    rmSync(path, { recursive: true, force: true });
  });
  const restarted = new SyncEngine(remote, store);
  assert.equal(restarted.desktopSnapshot().tasks[0].end, '2026-12-02');
  await restarted.sync();
  assert.equal(tasks.get(task.id).end, '2026-12-02');
  assert.equal([...events.values()][0].end, '2026-12-02');
  restarted.enqueueTask({ kind: 'update', id: task.id, values: { status: '已取消' } });
  await restarted.sync();
  assert.equal(tasks.get(task.id).status, '已取消');
  assert.equal(events.size, 0);
});

test('未完成待办跨日期排序的连续权重只写入待办表', async (t) => {
  const {engine, todos, writes} = fixture(t);
  todos.set('a', {id:'a', title:'第一项', date:'2026-11-25', done:false});
  todos.set('b', {id:'b', title:'第二项', date:null, done:false});
  todos.set('c', {id:'c', title:'已完成', date:'2026-11-24', done:true});
  await engine.sync();
  assert.throws(() => engine.orderTodos(['a','c']), /待办列表已更新/);
  engine.orderTodos(['b','a']);
  assert.equal(engine.desktopSnapshot().pendingTodos, 2);
  await engine.sync();
  assert.equal(todos.get('b').order,1000);
  assert.equal(todos.get('a').order,2000);
  assert.deepEqual(writes,['update-todo','update-todo']);
});

test('首轮同步把 57 条已发布日程一次关联到 Base，重跑时不再写入', async (t) => {
  const { engine, remote, tasks, events, writes } = fixture(t);
  for (let i = 1; i <= 57; i++) {
    const record = { ...task, id: 'record-' + i };
    tasks.set(record.id, record);
    events.set('event-' + i, { ...record, id: 'event-' + i, recordId: record.id });
  }
  remote.linkTask = async (id, eventId) => {
    tasks.get(id).eventId = eventId;
    writes.push('single-link');
    return true;
  };
  remote.linkTasks = async (links) => {
    assert.equal(links.length, 57);
    for (const {id, eventId} of links) tasks.get(id).eventId = eventId;
    writes.push('batch-link');
    return true;
  };
  await engine.sync();
  await engine.sync();
  assert.equal(engine.snapshot().tasks.filter(row => row.eventId).length, 57);
  assert.deepEqual(writes, ['batch-link']);
});
