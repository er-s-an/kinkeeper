// Virtual clock: demo time = real time + persisted offset.
// Lets the demo compress "three mornings" into minutes without touching
// any rule logic — everything downstream reads time only through here.
//
// setTime/advance validate before any write. An invalid date, a non-finite
// delta, or a result outside the JS Date range must leave clock_offset_ms
// untouched — writing "NaN" or "Infinity" makes nowIso throw and poisons
// every later read.
const INSTANT_MIN = -8640000000000000;
const INSTANT_MAX = 8640000000000000;

function clockInputError(message) {
  const err = new Error(message);
  err.code = 'CLOCK_INPUT';
  return err;
}

function validInstant(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= INSTANT_MIN && ms <= INSTANT_MAX;
}

export function createClock(store) {
  const KEY = 'clock_offset_ms';

  function offsetMs() {
    const raw = store.getConfig(KEY);
    if (raw == null || raw === '') return 0;
    return Number(raw);
  }

  return {
    now() {
      return new Date(Date.now() + offsetMs());
    },
    nowIso() {
      return this.now().toISOString();
    },
    advance(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw clockInputError('advance requires a finite number of milliseconds');
      }
      const current = offsetMs();
      if (!Number.isFinite(current)) {
        throw clockInputError('clock offset is already invalid');
      }
      const next = current + ms;
      const instant = Date.now() + next;
      if (!Number.isFinite(next) || !validInstant(instant)) {
        throw clockInputError('advance would produce an invalid clock time');
      }
      store.setConfig(KEY, String(next));
      return this.now();
    },
    setTime(date) {
      if (!(date instanceof Date) || !validInstant(date.getTime())) {
        throw clockInputError('setTime requires a valid Date');
      }
      const next = date.getTime() - Date.now();
      if (!Number.isFinite(next)) {
        throw clockInputError('setTime offset is not finite');
      }
      store.setConfig(KEY, String(next));
      return this.now();
    },
    reset() {
      store.setConfig(KEY, '0');
      return this.now();
    },
  };
}
