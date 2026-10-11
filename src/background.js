// Auto-lock: unlocked secrets live in chrome.storage.session; this worker clears them
// after the configured idle period. Every extension page reports activity.
const ALARM = 'auto-lock';

async function minutes() {
  const { settings } = await chrome.storage.local.get('settings');
  const value = Number(settings?.autoLockMinutes);
  return Number.isFinite(value) && value >= 1 && value <= 240 ? value : 15;
}
async function schedule() {
  await chrome.alarms.create(ALARM, { delayInMinutes: await minutes() });
}
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'activity') schedule();
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM) await chrome.storage.session.remove('unlocked');
});
chrome.idle?.onStateChanged.addListener(async (state) => {
  if (state === 'locked') await chrome.storage.session.remove('unlocked');
});
chrome.runtime.onStartup.addListener(() => chrome.storage.session.remove('unlocked'));
chrome.runtime.onInstalled.addListener(() => chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }));
