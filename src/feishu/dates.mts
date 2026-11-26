export function addDays(value: string, amount: number): string {
  const date = new Date(value + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return addDays(value, 0) === value; } catch { return false; }
}

export class Dates {
  #date: Intl.DateTimeFormat;
  #offset: Intl.DateTimeFormat;

  constructor(zone: string) {
    this.#date = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short' });
    this.#offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' });
  }

  day(ms: unknown): string | null {
    return typeof ms === 'number' && Number.isFinite(ms) ? this.#date.format(ms) : null;
  }

  midnight(day: string | null): number | null {
    if (day === null) return null;
    if (!validDate(day)) throw new Error('日期须为有效的 YYYY-MM-DD');
    const utc = Date.parse(day + 'T00:00:00Z');
    let instant = utc;
    for (let step = 0; step < 3; step++) {
      const zone = this.#offset.formatToParts(instant).find(part => part.type === 'timeZoneName')?.value;
      const offset = zone === 'GMT' ? 'Z' : zone?.slice(3);
      const next = Date.parse(day + 'T00:00:00' + offset);
      if (next === instant) return next;
      instant = next;
    }
    if (!Number.isFinite(instant) || this.day(instant) !== day) throw new Error('配置时区中日期不可用');
    return instant;
  }
}
