export type Shared = {
  title: string;
  start: string | null;
  end: string | null;
  notes: string;
};

export type TaskValues = Shared & {
  status?: string;
  category?: string;
  priority?: string;
  progress?: number | null;
};

export type Task = TaskValues & {
  id: string;
  cancelled?: boolean;
  eventId?: string;
  linkedCalendar?: boolean;
  notesWritable?: boolean;
};

export type Todo = {
  id: string;
  title: string;
  date: string | null;
  done: boolean;
  order?: number;
  notes?: string;
  priority?: string;
};

export type CalendarEvent = Shared & { id: string; recordId?: string; deleted?: boolean };
export type TaskLink = { id: string; eventId: string };

export interface Remote {
  listTasks(): Promise<Task[]>;
  listTodos(): Promise<Todo[]>;
  listEvents(cursor?: string): Promise<{ events: CalendarEvent[]; cursor?: string; full?: boolean }>;
  getEvent(id: string): Promise<CalendarEvent | null>;
  createEvent(recordId: string, values: Shared, key: string): Promise<CalendarEvent>;
  updateEvent(id: string, recordId: string, patch: Partial<Shared>): Promise<void>;
  deleteEvent(id: string): Promise<void>;
  updateTask(id: string, patch: Partial<TaskValues> & { eventId?: string }): Promise<void>;
  createTask?(values: TaskValues, key: string): Promise<Task>;
  deleteTask?(id: string): Promise<void>;
  isCancelledStatus?(status?: string): boolean;
  linkTask?(id: string, eventId: string): Promise<boolean>;
  linkTasks?(links: TaskLink[]): Promise<boolean>;
  updateTodo(id: string, patch: Partial<Omit<Todo, 'id'>>): Promise<void>;
  createTodo(values: Omit<Todo, 'id'>, key: string): Promise<Todo>;
  deleteTodo(id: string): Promise<void>;
  findEvent?(recordId: string): Promise<CalendarEvent | undefined>;
}

export type Mapping = {
  recordId: string;
  key: string;
  eventId?: string;
  last?: Shared;
  createValues?: Shared;
  retired?: boolean;
};

export type EditCommand<V> =
  | { kind: 'create'; values: V }
  | { kind: 'update'; id: string; values: Partial<V> }
  | { kind: 'delete'; id: string };
export type TodoCommand = EditCommand<Omit<Todo, 'id'>>;
export type TaskCommand = EditCommand<TaskValues>;

export const sharedFields = ['title', 'start', 'end', 'notes'] as const;

export function shared({ title, start, end, notes }: Shared): Shared {
  return { title, start, end, notes };
}

export function isScheduled(task: Task | Shared): boolean {
  return Boolean(task.start && task.end && task.start <= task.end
    && !('cancelled' in task && task.cancelled));
}
