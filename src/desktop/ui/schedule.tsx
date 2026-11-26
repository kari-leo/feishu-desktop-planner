import { useEffect, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointer } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, CirclePlus, LayoutList, ListFilter, Plus, Search, Trash2 } from 'lucide-react';
import { addDays } from '../../feishu/dates.mts';
import type { TaskValues } from '../../sync/types.mts';
import type { TaskItem, View } from '../contract.mts';
import { api, Banner, Chrome, message, Modal, Option, Status, useView, WidgetFooter } from './common';
import { changeRange, dayLabel, firstOfWeek, formatDay, hasRange, monthLabel, monthStart, monthWeeks,
  moveMonth, offset, taskTone, weekBars } from './calendar-model.mts';

type Range = { start: string; end: string };
type Editor = { task?: TaskItem; range?: Range };
type Drag = { kind: 'select' | 'move' | 'start' | 'end'; anchor: string; point: string; x: number; y: number;
  moved: boolean; task?: TaskItem & Range };
const daysOfWeek = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function Schedule() {
  const { view, error, act, clear } = useView();
  const [month, setMonth] = useState('');
  const anchor = month || monthStart(view.today);
  const [display, setDisplay] = useState<'month' | 'timeline'>('month');
  const [scale, setScale] = useState<'day' | 'week'>('day');
  const [filter, setFilter] = useState('');
  const [editor, setEditor] = useState<Editor>();
  const [list, setList] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag>();
  const dragRef = useRef<Drag | undefined>(undefined);
  const surface = useRef<HTMLDivElement>(null);
  const tasks = view.tasks.filter(task => !filter || (task.title + ' ' + (task.category ?? ''))
    .toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const visible = tasks.filter(hasRange);
  const unscheduled = tasks.filter(task => !hasRange(task));
  const weeks = monthWeeks(anchor);
  const inMonth = visible.filter(task => task.start < moveMonth(anchor, 1) && task.end >= anchor);
  const pointAt = (event: ReactPointer) => document.elementsFromPoint(event.clientX, event.clientY)
    .map(node => (node.closest('[data-day]') as HTMLElement | null)?.dataset.day).find(Boolean);

  function start(event: ReactPointer, kind: Drag['kind'], day?: string, task?: TaskItem & Range) {
    if (event.button !== 0 || task?.id.startsWith('local:')) return;
    const point = day ?? pointAt(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    surface.current?.setPointerCapture(event.pointerId);
    const next = { kind, anchor: point, point, task, moved: false, x: event.clientX, y: event.clientY };
    dragRef.current = next;
    setDrag(next);
  }

  function move(event: ReactPointer) {
    if (!dragRef.current) return;
    const current = dragRef.current;
    const point = pointAt(event) ?? current.point;
    const moved = current.moved || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 5;
    const next = { ...current, point, moved };
    dragRef.current = next;
    setDrag(next);
  }

  function end() {
    const current = dragRef.current;
    dragRef.current = undefined;
    setDrag(undefined);
    if (!current) return;
    if (current.kind === 'select') { setEditor({ range: range(current.anchor, current.point) }); return; }
    const task = current.task;
    if (!task) return;
    if (!current.moved) { setEditor({ task }); return; }
    if (current.point === current.anchor) return;
    const values = changeRange(task, current.anchor, current.point, current.kind);
    void act(() => api.task({ kind: 'update', id: task.id, values }));
  }

  const highlight = drag?.kind === 'select' ? range(drag.anchor, drag.point) : undefined;
  const projected = drag?.task && drag.moved && drag.kind !== 'select'
    ? tasks.map(task => task.id === drag.task?.id ? { ...task, ...changeRange(drag.task, drag.anchor, drag.point, drag.kind as 'move' | 'start' | 'end') } : task)
    : tasks;

  function bar(task: TaskItem & Range, startVisible: boolean, endVisible: boolean) {
    return <button className={'task-bar ' + taskTone(task) + (task.pending ? ' waiting' : '')}
      title={task.title + ' · ' + task.start + ' 至 ' + task.end + (task.status ? ' · ' + task.status : '')}
      aria-label={task.title}
      onPointerDown={event => start(event, 'move', undefined, task)}
      onClick={event => { if (!event.detail) setEditor({ task }); }}>
      {typeof task.progress === 'number' && <span className="bar-progress" style={{ width: Math.max(0, Math.min(100, task.progress)) + '%' }}/>}
      {startVisible && <span className="bar-handle start" onPointerDown={event => start(event, 'start', undefined, task)}/>}
      <span className="bar-title">{task.title}</span>
      {task.pending && <span className="pending-dot"/>}
      {endVisible && <span className="bar-handle end" onPointerDown={event => start(event, 'end', undefined, task)}/>}
    </button>;
  }

  const timelineStep = scale === 'day' ? 1 : 7;
  const timelineStart = scale === 'day' ? anchor : firstOfWeek(anchor);
  const timelineDays = Array.from({ length: Math.ceil(offset(timelineStart, moveMonth(anchor, 1)) / timelineStep) },
    (_, i) => addDays(timelineStart, i * timelineStep));
  const timelineEnd = addDays(timelineDays.at(-1)!, timelineStep - 1);

  return <div className="window schedule-window" data-theme={view.theme} data-mode={view.mode}>
    <Chrome view={view} kind="schedule"/>
    <main>
      <section className="widget-head schedule-head">
        <div className="widget-title"><div className="section-icon"><CalendarDays size={20}/></div>
          <div><h1>排期日历</h1><p>{inMonth.length} 项本月排期 <span className="middot">·</span> {unscheduled.length} 项未排期</p></div>
        </div>
        <div className="head-actions"><Status view={view} kind="schedule"/>
          <button className="primary" disabled={view.status === 'setup'} onClick={() => setEditor({})}><Plus size={17}/>新建任务</button>
        </div>
      </section>
      <Banner view={view} error={error} clear={clear}/>
      <section className="schedule-card">
        <div className="calendar-tools">
          <div className="month-navigation">
            <button className="icon-button outline" aria-label="上个月" title="上个月" onClick={() => setMonth(moveMonth(anchor, -1))}><ChevronLeft size={17}/></button>
            <h2>{monthLabel(anchor)}</h2>
            <button className="icon-button outline" aria-label="下个月" title="下个月" onClick={() => setMonth(moveMonth(anchor, 1))}><ChevronRight size={17}/></button>
            <button className="subtle" onClick={() => setMonth('')}>今天</button>
          </div>
          <div className="view-tools">
            <label className="search"><Search size={15}/><input aria-label="搜索任务" placeholder="搜索任务" value={filter}
              onChange={event => setFilter(event.target.value)}/></label>
            <button className="icon-button outline" aria-label="查看未排期任务" title="未排期任务" onClick={() => setList('unscheduled')}><ListFilter size={16}/></button>
            <div className="segmented" aria-label="排期视图">
              <button aria-pressed={display === 'month'} onClick={() => setDisplay('month')}><CalendarDays size={14}/>月历</button>
              <button aria-pressed={display === 'timeline'} onClick={() => setDisplay('timeline')}><LayoutList size={14}/>甘特</button>
            </div>
          </div>
        </div>
        <div ref={surface} className={'schedule-surface ' + (drag?.moved ? 'dragging' : '')} onPointerMove={move}
          onPointerUp={end} onPointerCancel={() => { dragRef.current = undefined; setDrag(undefined); }}>
          {display === 'month' ? <div className="month-grid">
            <div className="week-header">{daysOfWeek.map(day => <span key={day}>{day}</span>)}</div>
            {weeks.map(days => {
              const bars = weekBars(projected, days);
              return <div className="week" key={days[0]} style={{ '--lanes': 3 } as React.CSSProperties}>
                {days.map((day, index) => {
                  const hidden = bars.filter(bar => bar.lane >= 3 && bar.left <= index && bar.right >= index).length;
                  return <div key={day} data-day={day} style={{ gridColumn: index + 1 }} className={'day ' +
                    (monthStart(day) !== anchor ? ' outside' : '') + (day === view.today ? ' today' : '') +
                    (highlight && day >= highlight.start && day <= highlight.end ? ' selected-day' : '')}>
                    <button className="day-hit" aria-label={dayLabel(day) + '新建任务'} disabled={view.status === 'setup'}
                      onPointerDown={event => start(event, 'select', day)}
                      onClick={event => { if (!event.detail) setEditor({ range: range(day, day) }); }}>
                      <span className="day-num">{formatDay(day)}</span></button>
                    {hidden > 0 && <button className="overflow-task" title="查看当天任务" onClick={() => setList(day)}>+{hidden} 项</button>}
                  </div>;
                })}
                {bars.filter(entry => entry.lane < 3).map(({ task, left, right, lane }) =>
                  hasRange(task) && <div className="bar-slot" key={task.id} style={{ gridColumn: `${left + 1} / ${right + 2}`, gridRow: lane + 2 }}>
                    {bar(task, task.start >= days[0], task.end <= days[6])}</div>)}
              </div>;
            })}
          </div> : <div className="timeline">
            <div className="timeline-tools"><span>任务与时间</span><div className="segmented">
              <button aria-pressed={scale === 'day'} onClick={() => setScale('day')}>按日</button>
              <button aria-pressed={scale === 'week'} onClick={() => setScale('week')}>按周</button></div></div>
            <div className="timeline-scroll">
              <div className="timeline-body" style={{ '--columns': timelineDays.length,
                '--tick': scale === 'day' ? '32px' : '103px' } as React.CSSProperties}>
                <div className="timeline-row timeline-header"><div className="timeline-name">任务</div>
                  {timelineDays.map((day, index) => <div data-day={day} className="tick" key={day} style={{ gridColumn: index + 2 }}>
                    {scale === 'day' ? formatDay(day) : dayLabel(day)}</div>)}</div>
                {projected.filter(hasRange).filter(task => task.start <= timelineEnd && task.end >= timelineStart).map(task => {
                  const left = Math.max(0, Math.floor(offset(timelineStart, task.start) / timelineStep));
                  const right = Math.min(timelineDays.length - 1, Math.floor(offset(timelineStart, task.end) / timelineStep));
                  return <div className="timeline-row" key={task.id}>
                    <button className="timeline-name task-name" title={task.title} onClick={() => setEditor({ task })}>{task.title}</button>
                    {timelineDays.map((day, index) => <span className={'track-cell ' + (day === view.today ? 'is-today' : '')}
                      data-day={day} key={day} style={{ gridColumn: index + 2 }}/>)}
                    <div className="timeline-bar" style={{ gridColumn: `${left + 2} / ${right + 3}` }}>
                      {bar(task, task.start >= timelineStart, task.end <= timelineEnd)}</div>
                  </div>;
                })}
                {!inMonth.length && <div className="timeline-empty">本月还没有排期</div>}
              </div>
            </div>
          </div>}
        </div>
      </section>
      <WidgetFooter view={view}><span>{view.zone}</span>{view.lastSync && <span>{'最近同步 ' +
        new Intl.DateTimeFormat('zh-CN', { timeZone: view.zone, timeStyle: 'short' }).format(view.lastSync)}</span>}</WidgetFooter>
    </main>
    {list !== null && <Modal title={list === 'unscheduled' ? '未排期任务' : dayLabel(list)} close={() => setList(null)}>
      <div className="modal-list">{(list === 'unscheduled' ? unscheduled : visible.filter(task => task.start <= list && task.end >= list))
        .map(task => <button key={task.id} onClick={() => { setList(null); setEditor({ task }); }}><span className={'tone-dot ' + taskTone(task)}/>
          <span>{task.title}</span><small>{task.status||'任务详情'}</small></button>)}
        {(list === 'unscheduled' ? !unscheduled.length : !visible.some(task => task.start <= list && task.end >= list)) &&
          <p className="quiet-empty">暂无任务</p>}
      </div>
      <div className="dialog-actions"><button className="subtle" onClick={() => {
        setEditor(list === 'unscheduled' ? {} : { range: range(list, list) }); setList(null);
      }}><CirclePlus size={15}/>新建任务</button></div>
    </Modal>}
    {editor && <TaskEditor key={editor.task?.id ?? 'new'} editor={editor} view={view} close={() => setEditor(undefined)}/>}
  </div>;
}

function range(a: string, b: string): Range { return a <= b ? { start: a, end: b } : { start: b, end: a }; }

function TaskEditor({ editor, view, close }: { editor: Editor; view: View; close: () => void }) {
  const task = editor.task;
  const cap = view.capabilities;
  const [values, setValues] = useState<TaskValues>({
    title: task?.title ?? '', start: task?.start ?? editor.range?.start ?? null,
    end: task?.end ?? editor.range?.end ?? null, notes: task?.notes ?? '',
    status: task?.status ?? cap.status[0] ?? '', category: task?.category ?? '', priority: task?.priority ?? '',
    progress: task?.progress ?? null,
  });
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<'delete' | 'cancel'>();
  const set = <K extends keyof TaskValues,>(key: K, value: TaskValues[K]) => setValues(old => ({ ...old, [key]: value }));
  const temporary = task?.id.startsWith('local:');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); close(); }
    catch (error) { setFailure(message(error)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (values.start && values.end && values.end < values.start) { setFailure('截止日期不能早于开始日期'); return; }
    const shown = new Set(['title', 'start', 'end', 'status', ...cap.task]);
    if (task?.notesWritable) shown.add('notes');
    if (!task) {
      const entered = { ...values, title: values.title.trim() };
      for (const field of ['status', 'category', 'priority', 'progress'] as const) {
        if (!shown.has(field) || entered[field] === '' || entered[field] === null) delete entered[field];
      }
      if (!shown.has('notes')) entered.notes = '';
      void run(() => api.task({ kind: 'create', values: entered }));
      return;
    }
    const keys = (Object.keys(values) as (keyof TaskValues)[]).filter(key =>
      shown.has(key) && (values[key] ?? '') !== (task[key] ?? ''));
    if (!keys.length) { close(); return; }
    const patch = Object.fromEntries(keys.map(key => [key, values[key]]));
    void run(() => api.task({ kind: 'update', id: task.id, values: patch }));
  }
  return <Modal title={task ? '任务详情' : '新建任务'} subtitle={temporary ? '此任务正等待写入飞书' : undefined} close={close}>
    <form onSubmit={submit}>
      <div className="dialog-fields">
        <label className="field"><span>任务名称</span><input required maxLength={250} autoFocus value={values.title}
          onChange={event => set('title', event.target.value)} placeholder="输入任务名称"/></label>
        <div className="form-grid">
          <label className="field"><span>开始日期</span><input aria-label="开始日期" type="date" value={values.start ?? ''}
            onChange={event => set('start', event.target.value || null)}/></label>
          <label className="field"><span>截止日期</span><input aria-label="截止日期" type="date" value={values.end ?? ''}
            onChange={event => set('end', event.target.value || null)}/></label>
          <Option label="状态" value={values.status ?? ''} values={cap.status} set={value => set('status', value)}/>
          {cap.task.includes('category') && <Option label="分类" value={values.category ?? ''} values={cap.categories} set={value => set('category', value)}/>}
          {cap.task.includes('priority') && <Option label="优先级" value={values.priority ?? ''} values={cap.taskPriority} set={value => set('priority', value)}/>}
          {cap.task.includes('progress') && <label className="field"><span>进度（%）</span><input type="number" min="0" max="100"
            value={values.progress ?? ''} onChange={event => set('progress', event.target.value ? Number(event.target.value) : null)}/></label>}
        </div>
        {(cap.task.includes('notes') || task?.notesWritable) && <label className="field"><span>备注</span><textarea rows={3}
          value={values.notes} onChange={event => set('notes', event.target.value)}/></label>}
        {failure && <p className="form-error" role="alert">{failure}</p>}
        {confirmation && <div className="confirm-box" role="alert">
          <span>{confirmation === 'delete' ? '删除这项任务及其对应日程？' : '取消这项任务并移除对应日程？'}</span>
          <button type="button" className="danger" disabled={busy} onClick={() => task && void run(() => api.task(confirmation === 'delete'
            ? { kind: 'delete', id: task.id } : { kind: 'update', id: task.id, values: { status: cap.cancelStatus } }))}>确认</button>
          <button type="button" className="subtle" onClick={() => setConfirmation(undefined)}>返回</button>
        </div>}
      </div>
      <div className="dialog-actions">
        {task && !temporary && <div className="secondary-actions">
          <button type="button" className="danger-light" onClick={() => setConfirmation('delete')}><Trash2 size={15}/>删除</button>
          {!task.cancelled && <button type="button" className="subtle" onClick={() => setConfirmation('cancel')}>取消任务</button>}
        </div>}
        <button type="button" className="subtle" onClick={close}>关闭</button>
        <button className="primary" disabled={busy || temporary || Boolean(confirmation)}>保存</button>
      </div>
    </form>
  </Modal>;
}
