// Shared state and helpers for the popup and review pages. No DOM building here: the
// pages are React components; this module only wires the tested logic layer to chrome.*.
import { createVaultStore } from '../vault.js';
import { createWalletService, SETTINGS_KEY, SENDS_KEY, lamportsToSol } from '../wallet-service.js';
import { mergeSettings } from '../networks.js';

export const storage = { local: chrome.storage.local, session: chrome.storage.session };
export const vault = createVaultStore(storage);
export const service = createWalletService({ vault, storage });
export { lamportsToSol, SETTINGS_KEY, SENDS_KEY };

export async function getSettings() {
  return mergeSettings((await storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}
export async function saveSettings(next) {
  await storage.local.set({ [SETTINGS_KEY]: next });
}
// Any interaction pushes the auto-lock deadline back.
export function touch() {
  chrome.runtime.sendMessage({ type: 'activity' }).catch(() => {});
}
export function trackActivity() {
  document.addEventListener('click', touch, true);
  document.addEventListener('keydown', touch, true);
}
// Calls fn(changes, area) for storage changes to any of the given keys.
export function onStorageChange(keys, fn) {
  const listener = (changes, area) => {
    if (keys.some((k) => k in changes)) fn(changes, area);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function short(address, n = 4) {
  return address ? `${address.slice(0, n)}…${address.slice(-n)}` : '';
}
export function errorText(error) {
  return error?.message ?? String(error);
}
// Rounds a SOL amount for display only (never for signing): at most `digits` decimals.
export function solDisplay(lamports, digits = 4) {
  const full = lamportsToSol(lamports);
  const [whole, frac = ''] = full.split('.');
  const cut = frac.slice(0, digits).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}
export async function openReview(id) {
  await chrome.windows.create({
    url: chrome.runtime.getURL(`review.html?id=${encodeURIComponent(id)}`),
    type: 'popup',
    width: 420,
    height: 720,
  });
}
