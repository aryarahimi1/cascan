/**
 * Run at most one reconciliation at a time. Concurrent triggers join the
 * active promise and request one follow-up pass, so a callback retry cannot
 * falsely acknowledge while the original side effect is still running.
 */
export function createCoalescedTask(task) {
  if (typeof task !== 'function') throw new TypeError('coalesced task requires a function');
  let active = null;
  let dirty = false;

  return function run() {
    if (active) {
      dirty = true;
      return active;
    }
    active = (async () => {
      try {
        do {
          dirty = false;
          await task();
        } while (dirty);
      } finally {
        active = null;
      }
    })();
    return active;
  };
}
