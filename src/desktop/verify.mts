import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { View, WindowKind } from './contract.mts';
import { taskCommand, todoCommand } from './commands.mts';
import { PreferencesFile } from './preferences.mts';
import type { TodoCommand } from '../sync/types.mts';

export async function verify(directory: string, windows: Map<WindowKind, BrowserWindow>) {
  for (const win of windows.values()) await waitFor(win, 'Boolean(document.querySelector("h1"))');
  const schedule = windows.get('schedule')!;
  const todo = windows.get('todo')!;
  const settings = windows.get('settings')!;
  const web = schedule.webContents;
  const actions: unknown[] = [];
  let handleTodo: (command: TodoCommand) => void;
  for (const [channel, parse] of [
    ['planner:task', taskCommand], ['planner:todo', todoCommand], ['planner:order', (value: unknown) => value],
  ] as const) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, input) => {
      const command = parse(input);
      actions.push(command);
      if (channel === 'planner:todo') handleTodo(command as TodoCommand);
    });
  }
  const original = await web.executeJavaScript('window.planner.state()') as View;
  assert.equal(original.mode, 'browse');
  assert.equal(original.indentTodoPriorities, true);
  for (const win of [schedule, todo]) {
    assert.equal(win.isMovable(), false);
    assert.equal(win.isResizable(), false);
    assert.equal(win.isFocusable(), true);
    await waitFor(win, 'Boolean(document.querySelector("main .settings-entry")) && !document.querySelector(".chrome")');
  }
  const sample: View = {
    ...original, today: '2026-11-25', status: 'synced', message: '与飞书保持同步', lastSync: Date.now(),
    tasks: [
      { id: 'recPlan', title: '整理项目需求', start: '2026-11-23', end: '2026-11-27', status: '进行中', category: '项目', notes: '确认验收范围', progress: 64 },
      { id: 'recReview', title: '桌面验收与交付', start: '2026-11-26', end: '2026-12-02', status: '待开始', category: '交付', notes: '' },
      { id: 'recDraft', title: '迭代范围评审', start: '2026-11-18', end: '2026-11-22', status: '已完成', category: '项目', notes: '' },
      { id: 'recQueue', title: '补充整理飞书文档', start: '2026-11-25', end: '2026-11-26', status: '进行中', category: '文档', notes: '' },
      { id: 'recBacklog', title: '下一轮排期', start: null, end: null, status: '待开始', notes: '' },
    ],
    todos: [
      { id: 'recTodoA', title: '检查日历映射', date: '2026-11-25', done: false, order: 1000, priority: '低' },
      { id: 'recTodoB', title: '整理交付说明', date: '2026-11-25', done: false, order: 2000, priority: '高' },
      { id: 'recTodoC', title: '核对测试结果', date: '2026-11-25', done: true, order: 3000 },
      { id: 'recYesterday', title: '历史待办', date: '2026-11-24', done: true },
      { id: 'recOverdue', title: '昨天的未完成待办', date: '2026-11-24', done: false, order: 3000, priority: '中' },
      { id: 'recFuture', title: '未来的待办', date: '2026-11-27', done: false, order: 4000 },
      { id: 'recUndated', title: '未设日期的待办', date: null, done: false, order: 5000 },
    ],
    capabilities: { ...original.capabilities, task: ['title', 'status', 'start', 'end', 'notes', 'category', 'progress'],
      status: ['待开始', '进行中', '已完成', '已取消'], categories: ['项目', '交付', '文档'],
      todo: ['title', 'date', 'done', 'priority'], todoPriority: ['高', '中', '低'] },
  };
  let todoView = sample;
  const completeTodo = (...ids: string[]) => {
    todoView = { ...todoView, todos: todoView.todos.map(item => ids.includes(item.id) ? { ...item, done: true } : item) };
    todo.webContents.send('planner:state-changed', todoView);
  };
  handleTodo = command => {
    if (command.kind === 'update' && command.values.done === true) completeTodo(command.id);
    if (command.kind === 'create') {
      todoView = { ...todoView, todos: [...todoView.todos, { id: 'recNewTodo', ...command.values }] };
      todo.webContents.send('planner:state-changed', todoView);
    }
  };
  schedule.webContents.send('planner:state-changed', sample);
  todo.webContents.send('planner:state-changed', sample);
  await waitFor(schedule, 'document.querySelectorAll(".day").length === 42 && document.querySelectorAll(".task-bar").length > 3');
  await waitFor(todo, 'document.querySelectorAll(".todo-row").length === 5');
  assert.deepEqual(await todo.webContents.executeJavaScript(
    'Array.from(document.querySelectorAll(".todo-title > span"), node => node.textContent)'),
    ['检查日历映射', '整理交付说明', '昨天的未完成待办', '未来的待办', '未设日期的待办']);
  assert.equal(await todo.webContents.executeJavaScript('!document.querySelector("[role=progressbar]")'), true);
  assert.deepEqual(await todo.webContents.executeJavaScript(
    'Array.from(document.querySelectorAll(".todo-row"), row => getComputedStyle(row).marginInlineStart)'),
    ['16px', '0px', '8px', '0px', '0px']);
  await todo.webContents.executeJavaScript(`document.querySelector('button[aria-label="编辑 未设日期的待办"]').click()`);
  await waitFor(todo, 'Boolean(document.querySelector("dialog[open] input[type=date]"))');
  assert.equal(await todo.webContents.executeJavaScript('document.querySelector("dialog input[type=date]").value'), '');
  await todo.webContents.executeJavaScript('document.querySelector("dialog button[aria-label=关闭]").click()');
  await waitFor(todo, '!document.querySelector("dialog[open]")');
  assert.equal(await web.executeJavaScript(
    'window.process === undefined && typeof window.planner.state === "function"'), true);
  web.send('planner:state-changed', { ...sample, status: 'syncing', linking: 57 });
  await waitFor(schedule, 'document.querySelector(".sync-pill").textContent.includes("57 条日程")');
  web.send('planner:state-changed', sample);
  await waitFor(schedule, 'document.querySelector(".sync-pill").textContent.includes("已同步")');
  await capture(directory, 'schedule', schedule);
  await capture(directory, 'todo', todo);
  await capture(directory, 'settings', settings);

  await web.executeJavaScript(`(() => {
    const surface = document.querySelector('.schedule-surface');
    surface.setPointerCapture = () => {};
    const bar = document.querySelector('button[aria-label="整理项目需求"]');
    const target = document.querySelector('[data-day="2026-11-24"]');
    bar.scrollIntoView({block:'nearest'});
    const from = document.querySelector('[data-day="2026-11-23"]').getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const barTop = bar.getBoundingClientRect().top + 5;
    const send = (node,type,x,y) => node.dispatchEvent(new PointerEvent(type,{
      bubbles:true, button:0, pointerId:7, clientX:x, clientY:y
    }));
    send(bar, 'pointerdown', from.left + from.width / 2, barTop);
    send(surface, 'pointermove', to.left + to.width / 2, barTop);
    send(surface, 'pointerup', to.left + to.width / 2, barTop);
  })()`);
  await waitUntil(() => actions.length === 1);
  assert.deepEqual(actions[0], { kind: 'update', id: 'recPlan', values: { start: '2026-11-24', end: '2026-11-28' } });
  await todo.webContents.executeJavaScript(`document.querySelector('button[aria-label="调整顺序 整理交付说明"]')
    .dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
  await waitUntil(() => actions.length === 2);
  assert.deepEqual(actions[1], ['recTodoA', 'recOverdue', 'recTodoB', 'recFuture', 'recUndated']);
  await todo.webContents.executeJavaScript(`(() => {
    window.animatedTodos = new Set();
    new MutationObserver(() => {
      for (const exit of document.querySelectorAll('.todo-exit[aria-hidden=true]')) {
        if (getComputedStyle(exit).animationName === 'todo-fade-out') {
          window.animatedTodos.add(exit.querySelector('.todo-title > span').textContent);
        }
      }
    }).observe(document.querySelector('.todo-lists'), {childList:true,subtree:true});
    document.querySelector('button[aria-label="完成 检查日历映射"]').click();
  })()`);
  await waitUntil(() => actions.length === 3);
  assert.deepEqual(actions[2], { kind: 'update', id: 'recTodoA', values: { done: true } });
  await waitFor(todo, `window.animatedTodos.has('检查日历映射') && !document.querySelector('.todo-lists').textContent.includes('检查日历映射')`);
  completeTodo('recOverdue');
  await waitFor(todo, `window.animatedTodos.has('昨天的未完成待办') && !document.querySelector('.todo-lists').textContent.includes('昨天的未完成待办')`);
  completeTodo('recTodoB');
  await waitFor(todo, `!document.querySelector('.todo-lists').textContent.includes('整理交付说明')`);
  assert.deepEqual(await todo.webContents.executeJavaScript(
    'Array.from(document.querySelectorAll(".todo-row:not(.todo-exit) .todo-title > span"), node => node.textContent)'),
    ['未来的待办', '未设日期的待办']);
  completeTodo('recFuture', 'recUndated');
  await waitFor(todo, `window.animatedTodos.has('未设日期的待办') && document.querySelector('.empty-state')?.textContent.includes('没有未完成的待办')`);
  todoView = sample;
  todo.webContents.send('planner:state-changed', sample);

  await web.executeJavaScript(`document.querySelector('[data-day="2026-11-25"] .day-hit').click()`);
  await waitFor(schedule, 'Boolean(document.querySelector("dialog[open]"))');
  await web.executeJavaScript(`(() => {
    const input = document.querySelector('dialog input[required]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '浏览模式新增');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await web.executeJavaScript('document.querySelector("dialog form").requestSubmit()');
  await waitUntil(() => actions.length === 4);
  assert.deepEqual(actions[3], { kind: 'create', values: {
    title: '浏览模式新增', start: '2026-11-25', end: '2026-11-25', status: '待开始', notes: '',
  } });
  await waitFor(schedule, '!document.querySelector("dialog[open]")');

  await web.executeJavaScript('Array.from(document.querySelectorAll("button")).find(b => b.textContent === "甘特").click()');
  await waitFor(schedule, 'Boolean(document.querySelector(".timeline")) && document.querySelectorAll(".timeline-bar").length === 4');
  await web.executeJavaScript('Array.from(document.querySelectorAll("button")).find(b => b.textContent === "按周").click()');
  await waitFor(schedule, 'document.querySelectorAll(".tick").length < 8');
  await capture(directory, 'timeline', schedule);
  await web.executeJavaScript('document.querySelector(".task-name").click()');
  await waitFor(schedule, 'Boolean(document.querySelector("dialog[open] input[value]"))');
  await web.executeJavaScript('document.querySelector("dialog .danger-light").click()');
  await waitFor(schedule, 'Boolean(document.querySelector(".confirm-box .danger"))');
  await web.executeJavaScript('document.querySelector(".confirm-box .danger").click()');
  await waitUntil(() => actions.length === 5);
  assert.deepEqual(actions[4], { kind: 'delete', id: 'recPlan' });
  await waitFor(schedule, '!document.querySelector("dialog[open]")');
  await todo.webContents.executeJavaScript(`(() => {
    const form = document.querySelector('.todo-add');
    const input = form.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '新建高优待办');
    input.dispatchEvent(new Event('input', {bubbles:true}));
    const select = form.querySelector('select');
    select.value = '高';
    select.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await todo.webContents.executeJavaScript('document.querySelector(".todo-add").requestSubmit()');
  await waitUntil(() => actions.length === 6);
  assert.deepEqual(actions[5], { kind: 'create', values: {
    title: '新建高优待办', date: '2026-11-25', done: false, priority: '高',
  } });
  await waitFor(todo, `Array.from(document.querySelectorAll('.todo-title'))
    .some(title => title.querySelector('span').textContent === '新建高优待办' && title.querySelector('small')?.textContent === '高')`);
  await waitFor(todo, 'document.querySelector(".todo-add select").value === ""');
  await settings.webContents.executeJavaScript('window.planner.mode("edit")');
  await waitFor(schedule, 'Boolean(document.querySelector(".chrome .layout-done"))');
  assert.equal(schedule.isMovable(), true);
  assert.equal(schedule.isResizable(), true);
  await capture(directory, 'layout', schedule);
  const bounds = schedule.getBounds();
  schedule.setBounds({ ...bounds, width: Math.min(bounds.width, 760), height: Math.min(bounds.height, 560) });
  await waitFor(schedule, 'document.documentElement.scrollWidth === innerWidth');
  await waitUntil(async () => {
    const settings = JSON.parse(await readFile(join(directory, 'planner-settings.json'), 'utf8'));
    return settings.layout.schedule.width === schedule.getBounds().width;
  });
  await web.executeJavaScript('document.querySelector(".layout-done").click()');
  await waitFor(schedule, '!document.querySelector(".chrome")');
  assert.equal(schedule.isResizable(), false);
  const settingsWeb = settings.webContents;
  await settingsWeb.executeJavaScript('Array.from(document.querySelectorAll("button")).find(b => b.textContent === "挂件外观").click()');
  await waitFor(settings, 'document.querySelectorAll("input[name=theme]").length === 3');
  await settingsWeb.executeJavaScript('document.querySelector("input[name=indentTodoPriorities]").click()');
  await settingsWeb.executeJavaScript('document.querySelector("form.settings-form").requestSubmit()');
  await waitFor(todo, 'window.planner.state().then(view => view.indentTodoPriorities === false)');
  assert.equal(new PreferencesFile(join(directory, 'planner-settings.json')).value.appearance.indentTodoPriorities, false);
  todo.webContents.send('planner:state-changed', { ...sample, indentTodoPriorities: false });
  await waitFor(todo, 'document.querySelectorAll(".todo-row").length === 5');
  assert.deepEqual(await todo.webContents.executeJavaScript(
    'Array.from(document.querySelectorAll(".todo-row"), row => [row.querySelector(".todo-title > span").textContent, getComputedStyle(row).marginInlineStart])'),
    [['检查日历映射', '0px'], ['整理交付说明', '0px'], ['昨天的未完成待办', '0px'], ['未来的待办', '0px'], ['未设日期的待办', '0px']]);
  for (const id of ['sand', 'night'] as const) {
    const name = id === 'sand' ? '暖砂' : '夜航';
    await settingsWeb.executeJavaScript(`Array.from(document.querySelectorAll('.theme-option'))
      .find(option => option.textContent === ${JSON.stringify(name)}).querySelector('input').click()`);
    for (const win of windows.values()) await waitFor(win, `document.querySelector('.window').dataset.theme === '${id}'`);
    const saved = JSON.parse(await readFile(join(directory, 'planner-settings.json'), 'utf8'));
    assert.equal(saved.appearance.theme, id);
    assert.equal(new PreferencesFile(join(directory, 'planner-settings.json')).value.appearance.theme, id);
    schedule.webContents.send('planner:state-changed', { ...sample, theme: id });
    todo.webContents.send('planner:state-changed', { ...sample, theme: id, indentTodoPriorities: false });
    await waitFor(schedule, 'document.querySelectorAll(".timeline-bar").length === 4');
    await waitFor(todo, 'document.querySelectorAll(".todo-row").length === 5');
    await capture(directory, 'schedule-' + id, schedule);
    await capture(directory, 'todo-' + id, todo);
  }
  await capture(directory, 'themes', settings);
  const after = { windows: windows.size, calendar: true, timeline: true, todo: true, settings: true,
    resize: true, layout: true, modes: true, browseCommands: true, themes: true, taskDrag: true,
    todoCommands: true, todoCompletion: true, allUnfinishedTodos: true, priorityIndent: true, newTodoPriority: true };
  await writeFile(join(directory, 'result.json'), JSON.stringify(after));
  console.log('Windows 桌面验证通过');
}

async function waitFor(win: BrowserWindow, expression: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await win.webContents.executeJavaScript(expression)) return; }
    catch { /* The initial document can change before the local renderer finishes loading. */ }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('桌面验证超时：' + expression);
}
async function capture(directory: string, name: string, win: BrowserWindow) {
  await new Promise(resolve => setTimeout(resolve, 270));
  const image = await win.webContents.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty()) throw new Error('无法读取窗口渲染结果：' + name);
  await writeFile(join(directory, name + '.png'), image.toPNG());
}

async function waitUntil(condition: () => boolean | Promise<boolean>) {
  for (let attempts = 0; attempts < 40; attempts++) {
    try { if (await condition()) return; } catch { /* Wait for native events and the debounced settings write. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('桌面操作未达到预期结果');
}
