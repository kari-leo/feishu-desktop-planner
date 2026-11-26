import type { Task, TaskCommand, Todo, TodoCommand } from '../sync/types.mts';

export type Widget = 'schedule' | 'todo';
export type WindowKind = Widget | 'settings';
export type Mode = 'edit' | 'browse';
export const themes = {
  mist: { name: '雾青', canvas: '#f1f5f2', paper: '#ffffff', ink: '#1b302a', accent: '#286756' },
  sand: { name: '暖砂', canvas: '#f7f1e8', paper: '#fffcf7', ink: '#3c3029', accent: '#8a4d37' },
  night: { name: '夜航', canvas: '#171e2b', paper: '#202938', ink: '#e4eaf5', accent: '#a9bffc' },
} as const;
export type Theme = keyof typeof themes;
export const defaultTheme: Theme = 'mist';
export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && Object.hasOwn(themes, value);
}
export type ConnectionForm = {
  appId: string; base: string; scheduleTable: string; todoTable: string; calendar: string;
  zone: string; seconds: string; websocket: boolean; scheduleFields: string; todoFields: string;
  cancelled: string; redirect: string;
};
export type Appearance = { opacity: number; autostart: boolean; theme: Theme; indentTodoPriorities: boolean };
export type Capabilities = {
  task: string[]; todo: string[]; status: string[]; categories: string[];
  taskPriority: string[]; todoPriority: string[]; cancelStatus: string;
};
export type SyncStatus = 'setup' | 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'authorization';
type QueueFlag = { pending?: boolean; failed?: boolean };
export type TaskItem = Task & QueueFlag;
export type TodoItem = Todo & QueueFlag;
export type View = {
  tasks: TaskItem[]; todos: TodoItem[]; pendingTasks: number; pendingTodos: number; conflicts: number;
  status: SyncStatus; message: string; lastSync?: number; connected: boolean;
  linking?: number;
  zone: string; today: string; mode: Mode; theme: Theme; indentTodoPriorities: boolean; capabilities: Capabilities;
};
export type Settings = { connection: ConnectionForm; appearance: Appearance; hasSecret: boolean };

export const emptyCapabilities: Capabilities = {
  task: ['title', 'start', 'end', 'status'], todo: ['title', 'date', 'done'],
  status: [], categories: [], taskPriority: [], todoPriority: [], cancelStatus: '已取消',
};

export interface DesktopBridge {
  state(): Promise<View>;
  subscribe(callback: (view: View) => void): () => void;
  task(command: TaskCommand): Promise<void>;
  todo(command: TodoCommand): Promise<void>;
  order(ids: string[]): Promise<void>;
  refresh(): Promise<void>;
  settings(): Promise<Settings>;
  saveConnection(form: ConnectionForm): Promise<void>;
  importConfiguration(): Promise<boolean>;
  appearance(values: Omit<Appearance, 'theme'>): Promise<void>;
  theme(theme: Theme): Promise<void>;
  authorize(): Promise<void>;
  show(kind: WindowKind): Promise<void>;
  mode(mode: Mode): Promise<void>;
  minimize(): Promise<void>;
  hide(): Promise<void>;
  resetLayout(): Promise<void>;
}
