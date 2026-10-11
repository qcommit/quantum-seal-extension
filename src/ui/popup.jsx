// Popup (400x600): gate (welcome / unlock) and the wallet shell with Home and Activity
// tabs, Send, Settings and Backup pages, and bottom sheets for network and Receive.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BUILT_IN, deploymentFor } from '../networks.js';
import {
  vault,
  service,
  getSettings,
  saveSettings,
  pinNetworkChoice,
  onStorageChange,
  trackActivity,
  errorText,
  SETTINGS_KEY,
} from './common.js';
import {
  CopyButton,
  Loading,
  Mark,
  Notice,
  QrCode,
  Sheet,
  TestAddressCaption,
  TestNetworkBanner,
  useLoad,
} from './components.jsx';
import { Check, ChevronDown, Gear, Globe, History, Home, Lock } from './icons.jsx';
import { Welcome, Unlock } from './onboarding.jsx';
import { HomeTab, ActivityTab } from './home.jsx';
import { SendPage } from './send.jsx';
import { SettingsPage, BackupPage, PassphrasePage, RemovePage } from './settings.jsx';

function App() {
  const [gate, setGate] = useState('loading');
  // Only the newest gate check may apply, so a slow check can never undo a lock.
  const seq = useRef(0);
  const checkGate = useCallback(async () => {
    const n = ++seq.current;
    const exists = await vault.exists();
    if (exists) await pinNetworkChoice();
    const unlocked = exists && (await vault.isUnlocked());
    if (n === seq.current) setGate(!exists ? 'welcome' : unlocked ? 'ready' : 'locked');
  }, []);
  useEffect(() => {
    checkGate();
    // Locking anywhere (auto-lock, Lock now, another window) shows the lock screen at once.
    return onStorageChange(['unlocked'], checkGate);
  }, [checkGate]);
  const lock = useCallback(async () => {
    seq.current++;
    setGate('locked');
    await vault.lock();
    checkGate();
  }, [checkGate]);

  if (gate === 'loading')
    return (
      <div className="gate">
        <Loading label="Opening Quantum Seal" />
      </div>
    );
  if (gate === 'welcome') return <Welcome onDone={checkGate} />;
  if (gate === 'locked') return <Unlock onDone={checkGate} />;
  // A fresh wallet shell after every unlock: it always opens on Home.
  return <Wallet onLock={lock} onRemoved={checkGate} />;
}

function Wallet({ onLock, onRemoved }) {
  const [page, setPage] = useState('home'); // home | activity | send | settings | backup | passphrase | remove
  const [sheet, setSheet] = useState(null); // network | receive
  const [reloadKey, setReloadKey] = useState(0);
  const [initialized, setInitialized] = useState(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const scroller = useRef(null);
  // The backup page returns to wherever it was opened from (Home's reminder or Settings).
  const backupReturn = useRef('settings');
  // Setup finishing swaps the whole page; start the new one at the top.
  useEffect(() => {
    scroller.current?.scrollTo(0, 0);
  }, [initialized]);
  useEffect(() => onStorageChange([SETTINGS_KEY], () => setSettingsVersion((v) => v + 1)), []);
  // On open (and per network): settle abandoned sends and return their proof deposits to
  // the fee key; refresh Home if any came back.
  const sweptFor = useRef(null);
  const settings = useLoad(async () => {
    const s = await getSettings();
    return { settings: s, available: await service.availability() };
  }, [settingsVersion]);
  const cluster = settings.data?.settings.cluster;
  useEffect(() => {
    if (!cluster || sweptFor.current === cluster) return;
    sweptFor.current = cluster;
    service
      .reclaimAbandoned()
      .then(({ reclaimed }) => reclaimed && setReloadKey((k) => k + 1))
      .catch(() => {});
  }, [cluster]);
  if (!settings.data)
    return (
      <div className="gate">
        <Loading label="Loading settings" />
      </div>
    );

  const { settings: s, available } = settings.data;
  const deployment = deploymentFor(s);
  let host = deployment.rpc;
  try {
    host = new URL(deployment.rpc).host;
  } catch {
    /* show the raw value */
  }
  const go = (next) => {
    setSheet(null);
    setPage(next);
    if (next === 'home') setReloadKey((k) => k + 1);
  };
  const inSettings = ['settings', 'backup', 'passphrase', 'remove'].includes(page);
  const showNav = initialized !== false || page !== 'home';

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          type="button"
          className="network-picker"
          aria-haspopup="dialog"
          aria-label={`Viewing ${deployment.label}. Change network`}
          onClick={() => setSheet('network')}
        >
          <Mark />
          <span className="network-text">
            <strong className="top-title">{deployment.label}</strong>
            <small>Solana · {host}</small>
          </span>
          <ChevronDown size={16} />
        </button>
        <button type="button" className="icon-button header-button" aria-label="Lock wallet" onClick={onLock}>
          <Lock size={19} />
        </button>
        <button
          type="button"
          className="icon-button header-button"
          aria-label="Settings"
          aria-pressed={inSettings}
          onClick={() => go(page === 'settings' ? 'home' : 'settings')}
        >
          <Gear size={19} />
        </button>
      </header>

      <TestNetworkBanner cluster={cluster} label={deployment.label} />

      <main className="page-scroll" ref={scroller} key={`${cluster}:${page}`}>
        {page === 'home' ? (
          <HomeTab
            reloadKey={reloadKey}
            onInitialized={setInitialized}
            onReceive={() => setSheet('receive')}
            onSend={() => go('send')}
            onSettings={() => go('settings')}
            onBackup={() => {
              backupReturn.current = 'home';
              go('backup');
            }}
          />
        ) : null}
        {page === 'activity' ? <ActivityTab /> : null}
        {page === 'send' ? <SendPage onBack={() => go('home')} /> : null}
        {page === 'settings' ? (
          <SettingsPage
          onBack={() => go('home')}
          onBackup={() => {
            backupReturn.current = 'settings';
            go('backup');
          }}
          onLock={onLock}
          onPassphrase={() => go('passphrase')}
          onRemove={() => go('remove')}
        />
        ) : null}
        {page === 'backup' ? <BackupPage onBack={() => go(backupReturn.current)} /> : null}
        {page === 'passphrase' ? <PassphrasePage onBack={() => go('settings')} /> : null}
        {page === 'remove' ? <RemovePage onBack={() => go('settings')} onRemoved={onRemoved} /> : null}
      </main>

      {showNav ? (
        <nav className="bottom-nav" aria-label="Wallet">
          <button
            type="button"
            className={page === 'home' || page === 'send' ? 'active' : ''}
            aria-current={page === 'home' ? 'page' : undefined}
            onClick={() => go('home')}
          >
            <Home size={21} />
            <span>Home</span>
          </button>
          <button
            type="button"
            className={page === 'activity' ? 'active' : ''}
            aria-current={page === 'activity' ? 'page' : undefined}
            onClick={() => go('activity')}
          >
            <History size={21} />
            <span>Activity</span>
          </button>
        </nav>
      ) : null}

      <Sheet open={sheet === 'network'} onClose={() => setSheet(null)} title="Choose network">
        <NetworkList
          current={cluster}
          available={available}
          onPick={async (id) => {
            if (id !== cluster) {
              const next = structuredClone(await getSettings());
              next.cluster = id;
              await saveSettings(next);
            }
            setInitialized(null);
            go('home');
          }}
        />
      </Sheet>
      <Sheet open={sheet === 'receive'} onClose={() => setSheet(null)} title="Receive">
        <Receive label={deployment.label} cluster={cluster} />
      </Sheet>
    </div>
  );
}

function NetworkList({ current, available, onPick }) {
  const describe = (id) => {
    if (id === 'mainnet-beta') return available[id] ? 'Solana mainnet' : 'Not available yet';
    if (!available[id]) return 'Set up in Settings (developers)';
    return id === 'devnet' ? 'Public test network' : '127.0.0.1:8899';
  };
  return (
    <>
      <p className="sheet-copy">The network this wallet shows and sends on. Each network has its own wallet address.</p>
      <div className="wallet-list">
        {Object.entries(BUILT_IN).map(([id, n]) => {
          // Only mainnet is locked until the release pins it; test networks can be configured.
          const disabled = id === 'mainnet-beta' && !available[id];
          return (
            <button
              type="button"
              key={id}
              className={`wallet-row${id === current ? ' selected' : ''}`}
              aria-pressed={id === current}
              disabled={disabled}
              onClick={() => onPick(id)}
            >
              <span className={`wallet-avatar net-${id}`} aria-hidden="true">
                <Globe size={16} />
              </span>
              <span className="token-name">
                <strong>{n.label}</strong>
                <small>{describe(id)}</small>
              </span>
              {id === current ? <Check size={16} /> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}

function Receive({ label, cluster }) {
  const d = useLoad(() => service.descriptor(), []);
  if (d.error) return <Notice kind="error">{errorText(d.error)}</Notice>;
  if (!d.data) return <Loading label="Loading address" />;
  return (
    <div className="receive">
      <p className="sheet-copy">
        Your wallet address on <strong>{label}</strong>, for SOL and classic SPL tokens (not Token-2022). Restoring your
        backup brings back this address.
      </p>
      <div className="address-card">
        <QrCode text={d.data.wallet} />
        <code className="address">{d.data.wallet}</code>
        <TestAddressCaption cluster={cluster} />
        <CopyButton text={d.data.wallet} />
      </div>
    </div>
  );
}

trackActivity();
createRoot(document.getElementById('app')).render(<App />);
