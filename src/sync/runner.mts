import type { Store } from '../storage/store.mts';
import type { SyncEngine } from './engine.mts';

export function runPeriodic(
  engine: SyncEngine, store: Store, interval: number, onError: (error: unknown) => void,
  onState?: (syncing: boolean, success?: boolean) => void,
) {
  let stopped = false;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let failed = 0;

  function schedule(delay: number) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      dirty = false;
      onState?.(true);
      active = engine.sync().then(() => { failed = 0; onState?.(false, true); }, (error: unknown) => {
        failed++;
        onError(error);
        onState?.(false, false);
      }).finally(() => {
        active = undefined;
        const delay = failed ? Math.min(interval, 2_000 * 2 ** Math.min(failed - 1, 8))
          : dirty ? 100 : Math.min(interval, engine.nextPendingDelay() ?? interval);
        schedule(delay);
      });
    }, delay);
  }

  function trigger(id?: string) {
    if (stopped) return;
    if (id && !store.notice(id)) return;
    if (active) dirty = true;
    else if (!failed || id === undefined) schedule(100);
  }

  let previous = Date.now();
  const resume = setInterval(() => {
    const now = Date.now();
    if (now - previous > 15_000) trigger();
    previous = now;
  }, 5_000);
  schedule(0);

  return {
    trigger,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(resume);
      await active;
    },
  };
}
