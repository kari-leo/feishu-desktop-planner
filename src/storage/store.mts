import { DatabaseSync } from 'node:sqlite';
import type { Mapping, Task, TaskCommand, Todo, TodoCommand } from '../sync/types.mts';
import type { Capabilities } from '../desktop/contract.mts';

type Settings = {
  tasks: Task[];
  todos: Todo[];
  cursor: string | null;
  capabilities: Capabilities;
};

type Bucket = 'tasks' | 'todos';
type RecordTypes = { tasks: Task; todos: Todo };
type Commands = { tasks: TaskCommand; todos: TodoCommand };
type Pending<K extends Bucket> = { id: string; command: Commands[K]; attempts: number; nextAt: number };
const queue = { tasks: 'schedule_outbox', todos: 'sync_outbox' } as const;

export class Store {
  #db: DatabaseSync;

  constructor(path: string, scope: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_mapping (record_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id TEXT PRIMARY KEY, command TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_outbox (
        id TEXT PRIMARY KEY, command TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_conflict (
        id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, record_id TEXT NOT NULL, field TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen_event (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
    `);
    this.#db.prepare("INSERT OR IGNORE INTO state VALUES ('scope', ?)").run(scope);
    if (this.#db.prepare("SELECT data FROM state WHERE key = 'scope'").get()?.data !== scope) {
      this.close();
      throw new Error('同步数据库属于其他飞书资源，请使用独立的数据目录');
    }
  }

  close() { this.#db.close(); }

  get<K extends keyof Settings>(key: K): Settings[K] | undefined {
    const row = this.#db.prepare('SELECT data FROM state WHERE key = ?').get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }

  put<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.#put(key, value);
  }

  #put(key: keyof Settings, value: unknown) {
    this.#db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  putRecords<K extends Bucket>(bucket: K, rows: RecordTypes[K][]) { this.#put(bucket, rows); }

  mappings(): Mapping[] {
    return this.#db.prepare('SELECT data FROM sync_mapping').all()
      .map(row => JSON.parse(String(row.data)));
  }

  saveMapping(mapping: Mapping) {
    this.#db.prepare(`
      INSERT INTO sync_mapping VALUES (?, ?)
      ON CONFLICT(record_id) DO UPDATE SET data = excluded.data
      WHERE sync_mapping.data <> excluded.data
    `)
      .run(mapping.recordId, JSON.stringify(mapping));
  }

  enqueue<K extends Bucket>(bucket: K, id: string, command: Commands[K]) {
    this.#db.prepare(`INSERT INTO ${queue[bucket]} VALUES (?, ?, 0, 0)`)
      .run(id, JSON.stringify(command));
  }

  enqueueBatch<K extends Bucket>(bucket: K, entries: { id: string; command: Commands[K] }[]) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const { id, command } of entries) this.enqueue(bucket, id, command);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  pending<K extends Bucket>(bucket: K): Pending<K>[] {
    return this.#db.prepare(`SELECT * FROM ${queue[bucket]} ORDER BY rowid`).all().map(row => ({
      id: String(row.id),
      command: JSON.parse(String(row.command)),
      attempts: Number(row.attempts),
      nextAt: Number(row.next_at),
    }));
  }

  defer(bucket: Bucket, id: string, attempts: number, nextAt: number) {
    this.#db.prepare(`UPDATE ${queue[bucket]} SET attempts = ?, next_at = ? WHERE id = ?`)
      .run(attempts, nextAt, id);
  }

  complete<K extends Bucket>(bucket: K, id: string, rows: RecordTypes[K][]) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.putRecords(bucket, rows);
      this.#db.prepare(`DELETE FROM ${queue[bucket]} WHERE id = ?`).run(id);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  retry() {
    this.#db.exec('UPDATE schedule_outbox SET next_at = 0; UPDATE sync_outbox SET next_at = 0');
  }

  conflict(recordId: string, field: string) {
    this.#db.prepare('INSERT INTO sync_conflict (created_at, record_id, field) VALUES (?, ?, ?)')
      .run(new Date().toISOString(), recordId, field);
  }

  conflicts() {
    return Number(this.#db.prepare('SELECT COUNT(*) AS count FROM sync_conflict').get()?.count ?? 0);
  }

  notice(id: string): boolean {
    const now = Date.now();
    this.#db.prepare('DELETE FROM seen_event WHERE received_at < ?').run(now - 7 * 86_400_000);
    return this.#db.prepare('INSERT OR IGNORE INTO seen_event VALUES (?, ?)')
      .run(id, now).changes === 1;
  }
}
