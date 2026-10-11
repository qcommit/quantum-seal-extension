import test from 'node:test';
import assert from 'node:assert/strict';
import { area } from './support/fake-storage.mjs';

// A minimal chrome.* for the service worker: storage areas with onChanged events, alarms,
// and listener registries for the events the worker subscribes to.
function fakeChrome({ unlocked = false, alarm = false, minutes } = {}) {
  const listeners = { changed: [], alarm: [], message: [], idle: [], startup: [], installed: [] };
  const alarms = new Map();
  const wrap = (name, base) => ({
    get: base.get,
    async set(values) {
      const before = await base.get(Object.keys(values));
      await base.set(values);
      const changes = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, { oldValue: before[k], newValue: v }]),
      );
      for (const fn of listeners.changed) fn(changes, name);
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      const before = await base.get(keys);
      await base.remove(keys);
      const changes = Object.fromEntries(
        keys.filter((k) => k in before).map((k) => [k, { oldValue: before[k] }]),
      );
      if (Object.keys(changes).length) for (const fn of listeners.changed) fn(changes, name);
    },
  });
  const local = area(),
    session = area();
  if (minutes) local.set({ settings: { autoLockMinutes: minutes } });
  if (unlocked) session.set({ unlocked: { owner: 'aa', fee: 'bb' } });
  if (alarm) alarms.set('auto-lock', { name: 'auto-lock', delayInMinutes: 99 });
  const chrome = {
    storage: {
      local: wrap('local', local),
      session: wrap('session', session),
      onChanged: { addListener: (fn) => listeners.changed.push(fn) },
    },
    alarms: {
      create: async (name, info) => void alarms.set(name, { name, ...info }),
      get: async (name) => alarms.get(name),
      clear: async (name) => alarms.delete(name),
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    },
    idle: { onStateChanged: { addListener: (fn) => listeners.idle.push(fn) } },
  };
  return { chrome, alarms, listeners };
}
let n = 0;
async function startWorker(options) {
  const fake = fakeChrome(options);
  globalThis.chrome = fake.chrome;
  // A fresh module instance per test, as if the service worker started anew.
  const worker = await import(`../src/background.js?worker=${n++}`);
  await worker.ready;
  return fake;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('unlocking arms the auto-lock alarm without any page activity', async () => {
  const { chrome, alarms } = await startWorker({ minutes: 7 });
  assert.equal(alarms.size, 0);
  await chrome.storage.session.set({ unlocked: { owner: 'aa', fee: 'bb' } });
  await settle();
  assert.equal(alarms.get('auto-lock')?.delayInMinutes, 7);
});

test('locking clears the alarm, and the alarm locks the wallet', async () => {
  const { chrome, alarms, listeners } = await startWorker();
  await chrome.storage.session.set({ unlocked: { owner: 'aa', fee: 'bb' } });
  await settle();
  assert.ok(alarms.has('auto-lock'));
  for (const fn of listeners.alarm) await fn({ name: 'auto-lock' });
  await settle();
  assert.equal((await chrome.storage.session.get('unlocked')).unlocked, undefined);
  assert.equal(alarms.size, 0);
});

test('a worker that starts while unlocked schedules a missing alarm, but keeps an existing one', async () => {
  const started = await startWorker({ unlocked: true });
  assert.equal(started.alarms.get('auto-lock')?.delayInMinutes, 15);
  const kept = await startWorker({ unlocked: true, alarm: true });
  assert.equal(kept.alarms.get('auto-lock')?.delayInMinutes, 99);
  const locked = await startWorker({ unlocked: false });
  assert.equal(locked.alarms.size, 0);
});

test('activity extends an unlocked session but never arms a locked one', async () => {
  const { chrome, alarms, listeners } = await startWorker();
  for (const fn of listeners.message) fn({ type: 'activity' });
  await settle();
  assert.equal(alarms.size, 0);
  await chrome.storage.session.set({ unlocked: { owner: 'aa', fee: 'bb' } });
  await settle();
  alarms.clear();
  for (const fn of listeners.message) fn({ type: 'activity' });
  await settle();
  assert.ok(alarms.has('auto-lock'));
});
