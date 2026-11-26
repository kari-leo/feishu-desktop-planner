import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, Check, ChevronDown, CloudOff, GripHorizontal, Minus, RefreshCw, Settings, X } from 'lucide-react';
import { defaultTheme, emptyCapabilities } from '../contract.mts';
import type { DesktopBridge, View, WindowKind } from '../contract.mts';

declare global { interface Window { planner: DesktopBridge } }
export const api = window.planner;

const defaultView: View = {
  tasks: [], todos: [], pendingTasks: 0, pendingTodos: 0, conflicts: 0,
  status: 'idle', message: '正在读取本地数据', connected: false, mode: 'browse', theme: defaultTheme,
  indentTodoPriorities: true,
  zone: 'Asia/Shanghai', today: new Date().toISOString().slice(0, 10), capabilities: emptyCapabilities,
};

export function useView() {
  const [view, setView] = useState(defaultView);
  const [error, setError] = useState('');
  useEffect(() => {
    let changed = false;
    const unsubscribe = api.subscribe(next => { changed = true; setView(next); });
    void api.state().then(next => { if (!changed) setView(next); }).catch(err => setError(message(err)));
    return unsubscribe;
  }, []);
  async function act<T>(action: () => Promise<T>): Promise<T | undefined> {
    try { setError(''); return await action(); }
    catch (err) { setError(message(err)); return undefined; }
  }
  return { view, error, act, clear: () => setError('') };
}

export function message(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作未完成';
}

export function Chrome({ kind, view }: { kind: WindowKind; view: View }) {
  if (kind !== 'settings' && view.mode === 'browse') return null;
  const layout = kind !== 'settings';
  return <header className="chrome">
    <span className="layout-label">
      {layout ? <><GripHorizontal size={18}/><strong>调整挂件布局</strong><span>拖动这里移动，拖动边缘调整大小</span></>
        : <><Settings size={15}/><strong>计划管理器</strong></>}
    </span>
    <div className="chrome-actions">
      {layout && <button className="layout-done" onClick={() => void api.mode('browse')}><Check size={14}/>完成</button>}
      <button className="icon-button" title="最小化" aria-label="最小化" onClick={() => void api.minimize()}><Minus size={16}/></button>
      <button className="icon-button close-window" title={kind === 'settings' ? '关闭设置' : '隐藏挂件'} aria-label="关闭窗口"
        onClick={() => void api.hide()}><X size={16}/></button>
    </div>
  </header>;
}

export function WidgetFooter({ view, children }: { view: View; children?: ReactNode }) {
  return <footer className="widget-footer">
    <div className="footer-info">{children}</div>
    <div className="widget-tools">
      <button className="widget-tool" title="立即同步" aria-label="立即同步" onClick={() => void api.refresh()}>
        <RefreshCw size={14} className={view.status === 'syncing' ? 'spin' : ''}/>
      </button>
      <button className="widget-tool settings-entry" onClick={() => void api.show('settings')}>
        <Settings size={14}/><span>设置</span>
      </button>
    </div>
  </footer>;
}

const statusText = { setup: '待连接', idle: '准备同步', syncing: '同步中', synced: '已同步',
  offline: '离线', error: '同步失败', authorization: '待授权' };

export function Status({ view, kind }: { view: View; kind: WindowKind }) {
  const pending = kind === 'schedule' ? view.pendingTasks : kind === 'todo' ? view.pendingTodos : view.pendingTasks + view.pendingTodos;
  const pendingLabel = kind !== 'todo' && view.status === 'syncing' && view.linking
    ? `关联 ${view.linking} 条日程`
    : pending && view.status === 'synced' ? '待同步' : statusText[view.status];
  return <span className={'sync-pill ' + view.status} title={view.message}>
    <span className="sync-dot"/>{pendingLabel}{pending ? <span className="sync-count">{pending}</span> : null}
  </span>;
}

export function Banner({ view, error, clear, settingsLink = true }: {
  view: View; error?: string; clear?: () => void; settingsLink?: boolean;
}) {
  const show = error || ['setup', 'offline', 'error', 'authorization'].includes(view.status);
  if (!show) return null;
  return <div className={'banner ' + (error || view.status === 'error' ? 'warning' : '')} role="status">
    {view.status === 'offline' && !error ? <CloudOff size={16}/> : <AlertCircle size={16}/>}
    <span>{error || view.message}</span>
    {settingsLink && !error && (view.status === 'setup' || view.status === 'authorization') &&
      <button onClick={() => void api.show('settings')}>{view.status === 'setup' ? '连接飞书' : '重新授权'}</button>}
    {error && clear && <button className="inline-icon" aria-label="关闭提示" onClick={clear}><X size={14}/></button>}
  </div>;
}

export function Modal({ title, subtitle, close, children }: {
  title: string; subtitle?: string; close: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);
  return <dialog ref={dialog} className="sheet" aria-label={title} onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section>
      <header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="icon-button outline" aria-label="关闭" onClick={close}><X size={17}/></button></header>
      {children}
    </section>
  </dialog>;
}

export function Option({ label, value, values, set }: {
  label: string; value: string; values: string[]; set: (value: string) => void;
}) {
  return <label className="field"><span>{label}</span>{values.length ? <span className="select-control">
    <select value={value} onChange={event => set(event.target.value)}>
      <option value="">请选择</option>
      {[...new Set(value ? [...values, value] : values)].map(option => <option key={option}>{option}</option>)}
    </select><ChevronDown size={14}/></span> : <input value={value} onChange={event => set(event.target.value)}/>}</label>;
}

export function Saved({ text }: { text: string }) {
  return text ? <span role="status" className="saved"><Check size={15}/>{text}</span> : null;
}
