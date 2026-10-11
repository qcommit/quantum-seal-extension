// Auto-lock: unlocked secrets live in chrome.storage.session; this worker clears them
// after the configured idle period. The lock alarm is armed by the worker itself whenever
// the session secrets appear (unlock, create, restore), so it never depends on a page
// remembering to report activity. Pages still report activity to push the deadline back.
const ALARM = 'auto-lock';
const SESSION_KEY = 'unlocked';

async function minutes() {
  const { settings } = await chrome.storage.local.get('settings');
  const value = Number(settings?.autoLockMinutes);
  return Number.isFinite(value) && value >= 1 && value <= 240 ? value : 15;
}
async function schedule() {
  await chrome.alarms.create(ALARM, { delayInMinutes: await minutes() });
}
async function lock() {
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.alarms.clear(ALARM);
}
async function isUnlocked() {
  return Boolean((await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY]);
}

chrome.runtime.onMessage.addListener((message) => {
  // Activity only extends an existing unlock; it never re-arms a locked wallet.
  if (message?.type === 'activity')
    isUnlocked().then((unlocked) => (unlocked ? schedule() : undefined));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !(SESSION_KEY in changes)) return;
  if (changes[SESSION_KEY].newValue) schedule();
  else chrome.alarms.clear(ALARM);
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM) await lock();
});
chrome.idle?.onStateChanged.addListener(async (state) => {
  if (state === 'locked') await lock();
});
chrome.runtime.onStartup.addListener(() => lock());
chrome.runtime.onInstalled.addListener(() => chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }));

// A worker that starts while the wallet is unlocked (for example after Chrome stopped an
// idle worker) makes sure a lock deadline exists.
export const ready = (async () => {
  if ((await isUnlocked()) && !(await chrome.alarms.get(ALARM))) await schedule();
})();
