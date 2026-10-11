import { createVaultStore } from '../vault.js';
import { createWalletService, SETTINGS_KEY, lamportsToSol } from '../wallet-service.js';
import { mergeSettings } from '../networks.js';
import qrcode from 'qrcode-generator';

export const storage = { local: chrome.storage.local, session: chrome.storage.session };
export const vault = createVaultStore(storage);
export const service = createWalletService({ vault, storage });
export { lamportsToSol };

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

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export function short(address, n = 4) {
  return address ? `${address.slice(0, n)}…${address.slice(-n)}` : '';
}
export function qr(text, cell = 4) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const size = q.getModuleCount();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const total = (size + 8) * cell;
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', total);
  bg.setAttribute('height', total);
  bg.setAttribute('fill', '#fff');
  svg.append(bg);
  let d = '';
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (q.isDark(r, c)) d += `M${(c + 4) * cell} ${(r + 4) * cell}h${cell}v${cell}h-${cell}z`;
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#05060c');
  svg.append(path);
  return svg;
}
export async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = old), 1200);
    }
  } catch {
    /* clipboard unavailable; the address stays visible for manual copy */
  }
}
export function errorText(error) {
  return error?.message ?? String(error);
}
