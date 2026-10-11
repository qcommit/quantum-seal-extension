// Mutual exclusion across every page of the extension (popup, review windows): Web Locks
// are shared by all contexts of the extension's origin. Where the API is missing (old
// test runtimes), an in-process queue gives the same semantics within one context.
const queues = new Map();

export class LockBusy extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockBusy';
  }
}

// Runs fn while holding `name`. With ifAvailable, throws LockBusy(busyMessage) instead of
// waiting when another context holds the lock.
export async function withLock(name, fn, { ifAvailable = false, busyMessage = 'Busy. Try again.' } = {}) {
  const key = `quantum-seal:${name}`;
  const locks = globalThis.navigator?.locks;
  if (locks?.request)
    return locks.request(key, { ifAvailable }, async (lock) => {
      if (!lock) throw new LockBusy(busyMessage);
      return fn();
    });
  const previous = queues.get(key);
  if (previous && ifAvailable) throw new LockBusy(busyMessage);
  let release;
  const mine = new Promise((r) => (release = r));
  const chained = (previous ?? Promise.resolve()).then(() => mine);
  queues.set(key, chained);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (queues.get(key) === chained) queues.delete(key);
  }
}
