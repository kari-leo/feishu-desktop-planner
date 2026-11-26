import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ClipboardCheck, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Todo } from '../../sync/types.mts';
import type { TodoItem, View } from '../contract.mts';
import { dayLabel, weekDay } from './calendar-model.mts';
import { api, Banner, Chrome, message, Modal, Option, Status, useView, WidgetFooter } from './common';

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
type ExitingTodo = { todo: TodoItem; index: number };

export function Today() {
  const { view, error, act, clear } = useView();
  const [typing, setTyping] = useState('');
  const [priority, setPriority] = useState('');
  const [editor, setEditor] = useState<TodoItem>();
  const [drag, setDrag] = useState('');
  const [over, setOver] = useState('');
  const [adding, setAdding] = useState(false);
  const { unfinished, completed } = useMemo(() => {
    const unfinished = view.todos.filter(todo => !todo.done).sort((a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
    return { unfinished, completed: new Set(view.todos.filter(todo => todo.done).map(todo => todo.id)) };
  }, [view.todos]);
  const canSetPriority = view.capabilities.todo.includes('priority');
  const priorityOptions = view.capabilities.todoPriority;
  const priorityLevels = useMemo(() => todoPriorityLevels(priorityOptions, view.todos), [priorityOptions, view.todos]);
  const available = unfinished.filter(item => !item.id.startsWith('local:'));
  const lastList = useRef<TodoItem[]>([]);
  const [exiting, setExiting] = useState<ExitingTodo[]>([]);

  function indent(todo: TodoItem) {
    return view.indentTodoPriorities ? priorityLevels.get(todo.priority?.trim() ?? '') ?? 0 : 0;
  }

  useLayoutEffect(() => {
    const previous = lastList.current;
    lastList.current = unfinished;
    const newlyDone = previous.flatMap((todo, index) => completed.has(todo.id) ? [{ todo, index }] : []);
    setExiting(current => {
      const next = current.filter(entry => completed.has(entry.todo.id));
      if (next.length === current.length && newlyDone.length === 0) return current;
      return [...next, ...newlyDone];
    });
  }, [completed, unfinished]);

  useEffect(() => {
    if (editor && !unfinished.some(todo => todo.id === editor.id)) setEditor(undefined);
  }, [editor, unfinished]);

  const finishExit = useCallback((id: string) => {
    setExiting(current => current.filter(entry => entry.todo.id !== id));
  }, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    const title = typing.trim();
    if (!title || adding) return;
    setAdding(true);
    await act(async () => {
      const selected = priority.trim();
      const values: Omit<Todo, 'id'> = { title, date: view.today, done: false };
      if (canSetPriority && selected && (!priorityOptions.length || priorityOptions.includes(selected))) {
        values.priority = selected;
      }
      await api.todo({ kind: 'create', values });
      setTyping('');
      setPriority('');
    });
    setAdding(false);
  }

  function reorder(id: string, target: string) {
    setDrag('');
    setOver('');
    const ids = available.map(item => item.id);
    const from = ids.indexOf(id), to = ids.indexOf(target);
    if (from === to || from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    void act(() => api.order(ids));
  }

  function item(todo: TodoItem) {
    const local = todo.id.startsWith('local:');
    const pointer = available.findIndex(entry => entry.id === todo.id);
    return <li key={todo.id} className={'todo-row' + (over === todo.id ? ' drop-target' : '')}
      style={{ marginInlineStart: indent(todo) }}
      onDragOver={event => { if (drag && drag !== todo.id && !local) { event.preventDefault(); setOver(todo.id); } }}
      onDrop={event => { event.preventDefault(); reorder(drag, todo.id); }}>
      <button className="todo-check" aria-label={'完成 ' + todo.title}
        disabled={local} onClick={() => void act(() => api.todo({ kind: 'update', id: todo.id, values: { done: true } }))}/>
      <TodoCopy todo={todo} today={view.today}/>
      {todo.pending && <span title={todo.failed ? '写入失败，待重试' : '等待同步'} className={'pending-dot ' + (todo.failed ? 'failed' : '')}/>}
      <button className="icon-button row-edit" aria-label={'编辑 ' + todo.title} disabled={local}
        onClick={() => setEditor(todo)}><Pencil size={14}/></button>
      <button className="icon-button todo-grip" draggable={!local} disabled={local} title="拖动排序，也可用方向键"
        aria-label={'调整顺序 ' + todo.title} onDragStart={event => {
          event.dataTransfer.setData('text/plain', todo.id);
          event.dataTransfer.effectAllowed = 'move';
          setDrag(todo.id);
        }} onDragEnd={() => { setDrag(''); setOver(''); }}
        onKeyDown={event => {
          const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
          const target = available[pointer + delta];
          if (delta && target) { event.preventDefault(); reorder(todo.id, target.id); }
        }}><GripVertical size={15}/></button>
    </li>;
  }

  const rows = unfinished.map(item);
  for (const { todo, index } of [...exiting].sort((a, b) => a.index - b.index)) {
    if (completed.has(todo.id)) {
      rows.splice(index, 0, <TodoExit key={todo.id} todo={todo} today={view.today} indent={indent(todo)} finish={finishExit}/>);
    }
  }

  return <div className="window todo-window" data-theme={view.theme} data-mode={view.mode}>
    <Chrome kind="todo" view={view}/>
    <main>
      <section className="widget-head todo-head"><div className="widget-title">
        <div className="section-icon"><ClipboardCheck size={21}/></div>
        <div><h1>今日待办</h1><p>{dayLabel(view.today)} <span className="middot">·</span> {weekdays[weekDay(view.today)]}</p></div>
      </div><Status view={view} kind="todo"/></section>
      <Banner view={view} error={error} clear={clear}/>
      <form className="todo-add" onSubmit={event => void add(event)}>
        <input className="todo-add-title" aria-label="待办事项" maxLength={250} placeholder="添加待办事项…" value={typing}
          onChange={event => setTyping(event.target.value)}/>
        {canSetPriority && (priorityOptions.length
          ? <div className="todo-add-priority">
            <select aria-label="新待办优先级" value={priorityOptions.includes(priority) ? priority : ''}
              onChange={event => setPriority(event.target.value)}>
              <option value="">优先级</option>
              {priorityOptions.map(option => <option value={option} key={option}>{option}</option>)}
            </select>
            <ChevronDown size={13}/>
          </div>
          : <input className="todo-add-priority" aria-label="新待办优先级" maxLength={120} placeholder="优先级"
            value={priority} onChange={event => setPriority(event.target.value)}/>)}
        <button className="primary" aria-label="添加待办" type="submit" disabled={!typing.trim() || view.status === 'setup' || adding}><Plus size={19}/></button>
      </form>
      <div className="todo-lists">
        {rows.length
          ? <section><h2>待完成 <span>{unfinished.length}</span></h2><ul>{rows}</ul></section>
          : <div className="empty-state"><span><ClipboardCheck size={26}/></span>
            <strong>没有未完成的待办</strong></div>}
      </div>
      <WidgetFooter view={view}><span>{view.zone}</span></WidgetFooter>
    </main>
    {editor && unfinished.some(todo => todo.id === editor.id) &&
      <TodoEditor item={editor} view={view} move={reorder} available={available} close={() => setEditor(undefined)}/>}
  </div>;
}

function todoPriorityLevels(options: string[], todos: TodoItem[]) {
  const conventional = ['紧急', '高', '中', '低'];
  const seen = new Set(todos.map(todo => todo.priority?.trim() ?? '').filter(Boolean));
  const configured = options.length ? options.map(option => option.trim()) : conventional.filter(level => seen.has(level));
  const levels = [...new Set(configured.filter(Boolean))];
  const collator = new Intl.Collator('zh-CN', { numeric: true });
  levels.push(...[...seen].filter(level => !levels.includes(level)).sort(collator.compare));
  const step = Math.min(8, 32 / Math.max(1, levels.length - 1));
  return new Map(levels.map((level, index) => [level, index * step]));
}

function TodoCopy({ todo, today }: { todo: TodoItem; today: string }) {
  const overdue = todo.date !== null && todo.date < today;
  const plannedDate = todo.date && (todo.date.slice(0, 4) === today.slice(0, 4)
    ? dayLabel(todo.date) : todo.date);
  return <div className="todo-copy">
    <div className="todo-title"><span title={todo.title}>{todo.title}</span>{todo.priority && <small>{todo.priority}</small>}</div>
    {todo.date !== today && <span className={'todo-date' + (overdue ? ' overdue' : '')}>
      {plannedDate ? overdue ? '逾期 · ' + plannedDate : plannedDate : '未设日期'}
    </span>}
  </div>;
}

function TodoExit({ todo, today, indent, finish }: { todo: TodoItem; today: string; indent: number; finish: (id: string) => void }) {
  useEffect(() => {
    const fallback = window.setTimeout(() => finish(todo.id), 400);
    return () => window.clearTimeout(fallback);
  }, [finish, todo.id]);
  return <li className="todo-row todo-exit" style={{ marginInlineStart: indent }} aria-hidden="true" onAnimationEnd={() => finish(todo.id)}>
    <span className="todo-check checked"><Check size={13} strokeWidth={3}/></span>
    <TodoCopy todo={todo} today={today}/>
  </li>;
}

function TodoEditor({ item, view, move, available, close }: {
  item: TodoItem; view: View; available: TodoItem[]; move: (id: string, target: string) => void; close: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [date, setDate] = useState(item.date ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [priority, setPriority] = useState(item.priority ?? '');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); close(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const values: Partial<Omit<Todo, 'id'>> = {};
    if (title.trim() !== item.title) values.title = title.trim();
    if ((date || null) !== item.date) values.date = date || null;
    if (view.capabilities.todo.includes('notes') && notes !== (item.notes ?? '')) values.notes = notes;
    if (view.capabilities.todo.includes('priority') && priority !== (item.priority ?? '')) values.priority = priority;
    if (!Object.keys(values).length) { close(); return; }
    void run(() => api.todo({ kind: 'update', id: item.id, values }));
  }
  const pos = available.findIndex(todo => todo.id === item.id);
  return <Modal title="编辑待办" close={close}>
    <form onSubmit={submit}>
      <div className="dialog-fields">
        <label className="field"><span>待办事项</span><input required maxLength={250} autoFocus value={title}
          onChange={event => setTitle(event.target.value)}/></label>
        <label className="field"><span>计划日期</span><input type="date" value={date}
          onChange={event => setDate(event.target.value)}/></label>
        {view.capabilities.todo.includes('priority') && <Option label="优先级" value={priority}
          values={view.capabilities.todoPriority} set={setPriority}/>}
        {view.capabilities.todo.includes('notes') && <label className="field"><span>备注</span><textarea value={notes}
          onChange={event => setNotes(event.target.value)} rows={2}/></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {confirm && <div className="confirm-box"><span>删除这条待办？</span><button className="danger" type="button" disabled={busy}
          onClick={() => void run(() => api.todo({kind:'delete', id:item.id}))}>确认删除</button></div>}
      </div>
      <div className="dialog-actions">
        <div className="secondary-actions">
          <button className="danger-light" type="button" aria-label="删除待办" onClick={() => setConfirm(!confirm)}><Trash2 size={15}/></button>
          {[-1, 1].map(delta => {
            const target = available[pos + delta];
            return <button className="icon-button outline" aria-label={delta < 0 ? '上移' : '下移'} type="button" key={delta}
              disabled={!target || confirm} onClick={() => { if (target) move(item.id, target.id); close(); }}>
              {delta < 0 ? <ArrowUp size={14}/> : <ArrowDown size={14}/>}</button>;
          })}
        </div>
        <button className="subtle" type="button" onClick={close}>关闭</button><button className="primary" disabled={busy || confirm}>保存</button>
      </div>
    </form>
  </Modal>;
}
