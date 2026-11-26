import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './contract.mts';

const bridge: DesktopBridge = {
  state: () => ipcRenderer.invoke('planner:state'),
  subscribe(callback) {
    const receive = (_event: unknown, value: Awaited<ReturnType<DesktopBridge['state']>>) => callback(value);
    ipcRenderer.on('planner:state-changed', receive);
    return () => ipcRenderer.removeListener('planner:state-changed', receive);
  },
  task: command => ipcRenderer.invoke('planner:task', command),
  todo: command => ipcRenderer.invoke('planner:todo', command),
  order: ids => ipcRenderer.invoke('planner:order', ids),
  refresh: () => ipcRenderer.invoke('planner:refresh'),
  settings: () => ipcRenderer.invoke('planner:settings'),
  saveConnection: form => ipcRenderer.invoke('planner:connection', form),
  importConfiguration: () => ipcRenderer.invoke('planner:import'),
  appearance: values => ipcRenderer.invoke('planner:appearance', values),
  theme: theme => ipcRenderer.invoke('planner:theme', theme),
  authorize: () => ipcRenderer.invoke('planner:authorize'),
  show: kind => ipcRenderer.invoke('planner:show', kind),
  mode: mode => ipcRenderer.invoke('planner:mode', mode),
  minimize: () => ipcRenderer.invoke('planner:minimize'),
  hide: () => ipcRenderer.invoke('planner:hide'),
  resetLayout: () => ipcRenderer.invoke('planner:reset-layout'),
};
contextBridge.exposeInMainWorld('planner', bridge);
