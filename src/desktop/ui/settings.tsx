import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CalendarClock, Check, Cloud, Download, ExternalLink, Settings2 } from 'lucide-react';
import { themes } from '../contract.mts';
import type { Appearance, ConnectionForm, Settings as SettingsModel, Theme } from '../contract.mts';
import { api, Banner, Chrome, message, Saved, Status, useView } from './common';

const fields: {key: Exclude<keyof ConnectionForm, 'websocket'>; label: string; placeholder?: string}[] = [
  { key: 'appId', label: 'App ID', placeholder: 'cli_…' },
  { key: 'base', label: 'Base ID' }, { key: 'scheduleTable', label: '排期表 ID' },
  { key: 'todoTable', label: '待办表 ID' }, { key: 'calendar', label: '共享日历 ID' },
  { key: 'zone', label: '时区', placeholder: 'Asia/Shanghai' },
  { key: 'seconds', label: '同步间隔（秒）', placeholder: '300' },
  { key: 'redirect', label: 'OAuth 回调地址' },
  { key: 'cancelled', label: '取消状态名称', placeholder: '已取消,取消' },
];

export function Settings() {
  const { view, error, clear } = useView();
  const [model, setModel] = useState<SettingsModel>();
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [section, setSection] = useState<'connection' | 'appearance'>('connection');
  const [busy, setBusy] = useState(false);
  const reload = () => api.settings().then(setModel);
  useEffect(() => { void reload().catch(error => setFailure(message(error))); }, []);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      const result = await action();
      if (result !== false) { await reload(); setNotice(success); }
    } catch (error) { setFailure(message(error)); }
    finally { setBusy(false); }
  }
  function update(key: keyof ConnectionForm, value: string | boolean) {
    setModel(old => old && ({ ...old, connection: { ...old.connection, [key]: value } }));
  }
  function appearance<K extends keyof Appearance>(key: K, value: Appearance[K]) {
    setModel(old => old && ({ ...old, appearance: { ...old.appearance, [key]: value } }));
  }
  async function chooseTheme(theme: Theme) {
    setFailure('');
    try { await api.theme(theme); }
    catch (error) { setFailure(message(error)); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (model) void run(() => section === 'connection' ? api.saveConnection(model.connection)
      : api.appearance(model.appearance), '已保存');
  }

  return <div className="window settings-window" data-theme={view.theme}>
    <Chrome kind="settings" view={view}/>
    <main>
      <section className="widget-head"><div className="widget-title">
        <div className="section-icon"><Settings2 size={22}/></div><div><h1>设置</h1><p>飞书连接与桌面挂件</p></div>
      </div><Status view={view} kind="settings"/></section>
      <Banner view={view} settingsLink={false} error={failure || error} clear={() => { setFailure(''); clear(); }}/>
      <div className="settings-tabs segmented"><button aria-pressed={section === 'connection'} onClick={() => setSection('connection')}>
        <Cloud size={15}/>飞书连接</button><button aria-pressed={section === 'appearance'} onClick={() => setSection('appearance')}>
        <CalendarClock size={15}/>挂件外观</button></div>
      {model && <form onSubmit={save} className="settings-form">
        <div className="settings-scroll">
          {section === 'connection' ? <>
            <section className="settings-panel">
              <div className="settings-credentials"><div><h2>应用凭证</h2><p>{model.hasSecret ? 'App Secret 已配置' : '从 .env 文件导入 App Secret'}</p></div>
                <button type="button" className="subtle" disabled={busy} onClick={() => void run(() => api.importConfiguration(), '已导入飞书配置')}>
                  <Download size={16}/>导入 .env</button></div>
              <div className="form-grid">{fields.map(({key, label, placeholder}) =>
                <label className="field" key={key}><span>{label}</span><input value={model.connection[key]} placeholder={placeholder}
                  type={key === 'seconds' ? 'number' : 'text'} min={key === 'seconds' ? 15 : undefined}
                  max={key === 'seconds' ? 3600 : undefined} required={key !== 'cancelled'}
                  onChange={event => update(key, event.target.value)}/></label>)}</div>
              <label className="toggle-line"><input type="checkbox" checked={model.connection.websocket}
                onChange={event => update('websocket', event.target.checked)}/><span>使用 WebSocket 接收飞书变更</span></label>
            </section>
            <details className="settings-panel"><summary>字段映射</summary>
              <label className="field"><span>排期表字段（JSON）</span><textarea rows={2} spellCheck={false}
                placeholder={'{ "title": "任务名称", "start": "任务开始日期" }'} value={model.connection.scheduleFields}
                onChange={event => update('scheduleFields', event.target.value)}/></label>
              <label className="field"><span>待办表字段（JSON）</span><textarea rows={2} spellCheck={false}
                placeholder={'{ "title": "待办事项", "order": "排序权重" }'} value={model.connection.todoFields}
                onChange={event => update('todoFields', event.target.value)}/></label>
            </details>
          </> : <section className="settings-panel appearance">
            <fieldset className="theme-fieldset"><legend>挂件配色</legend>
              <div className="theme-options">{(Object.keys(themes) as Theme[]).map(id => {
                const colors = themes[id];
                return <label className="theme-option" key={id}>
                  <input type="radio" name="theme" checked={view.theme === id} onChange={() => void chooseTheme(id)}/>
                  <span className="theme-preview" style={{ background: colors.canvas, color: colors.ink }}>
                    <span className="theme-mini" style={{ background: colors.paper }}>
                      <span style={{ background: colors.accent }}/><span/><span/>
                    </span>
                  </span>
                  <span className="theme-caption">{colors.name}{view.theme === id && <Check size={15}/>}</span>
                </label>;
              })}</div>
            </fieldset>
            <label className="field"><span>挂件不透明度 <strong>{Math.round(model.appearance.opacity * 100)}%</strong></span>
              <input type="range" min=".55" max="1" step=".05" value={model.appearance.opacity}
                onChange={event => appearance('opacity', Number(event.target.value))}/></label>
            <label className="toggle-line"><input type="checkbox" checked={model.appearance.autostart}
              onChange={event => appearance('autostart', event.target.checked)}/><span>随 Windows 登录启动</span></label>
            <label className="toggle-line"><input type="checkbox" name="indentTodoPriorities" checked={model.appearance.indentTodoPriorities}
              onChange={event => appearance('indentTodoPriorities', event.target.checked)}/><span>按优先级缩进待办</span></label>
            <div className="settings-mode"><div><h2>挂件布局</h2>
              <p>{view.mode === 'browse' ? '可操作日程和待办，窗口位置和大小已锁定。' : '拖动挂件的布局栏移动，拖动窗口边缘调整大小。'}</p></div>
              <div className="segmented"><button type="button" aria-pressed={view.mode === 'browse'} onClick={() => void api.mode('browse')}>浏览</button>
                <button type="button" aria-pressed={view.mode === 'edit'} onClick={() => void api.mode('edit')}>调整布局</button></div>
            </div>
            <button type="button" className="subtle outline" onClick={() => void run(() => api.resetLayout(), '已重置布局')}>恢复默认窗口布局</button>
          </section>}
        </div>
        <div className="settings-footer"><Saved text={notice}/>
          {section === 'connection' && <button type="button" className="subtle outline" disabled={busy || !model.hasSecret}
            onClick={() => void run(() => api.authorize(), '飞书授权已更新')}><ExternalLink size={15}/>浏览器授权</button>}
          <button className="primary" disabled={busy} type="submit">保存{section === 'connection' ? '配置' : '外观'}</button>
        </div>
      </form>}
    </main>
  </div>;
}
