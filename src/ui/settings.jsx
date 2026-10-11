// Settings (RPC override, auto-lock, developer pins, backup, lock) and the backup page.
import { useRef, useState } from 'react';
import { BUILT_IN, deploymentFor, isAvailable, networkConfig } from '../networks.js';
import { vault, service, getSettings, saveSettings, touch, solDisplay } from './common.js';
import { ActionButton, ActionNotice, Field, Loading, Notice, useAction, useLoad } from './components.jsx';
import { Alert, ArrowLeft, ChevronRight, Code, Download, Key, Lock, Shield } from './icons.jsx';

const PIN_FIELDS = [
  ['program', 'Program address'],
  ['programSha256', 'Program SHA-256'],
  ['programSize', 'Program size (bytes)'],
  ['upgradeAuthority', 'Upgrade authority'],
  ['genesis', 'Genesis hash'],
];

export function SettingsPage({ onBack, onBackup, onLock, onPassphrase, onRemove }) {
  const loaded = useLoad(() => getSettings(), []);
  if (!loaded.data) return <Loading label="Loading settings" />;
  return (
    <SettingsForm
      initial={loaded.data}
      onBack={onBack}
      onBackup={onBackup}
      onLock={onLock}
      onPassphrase={onPassphrase}
      onRemove={onRemove}
    />
  );
}

function SettingsForm({ initial, onBack, onBackup, onLock, onPassphrase, onRemove }) {
  const cluster = initial.cluster;
  const network = BUILT_IN[cluster];
  const current = deploymentFor(initial);
  const [rpc, setRpc] = useState(initial.rpc?.[cluster] ?? '');
  const [lockMinutes, setLockMinutes] = useState(String(initial.autoLockMinutes));
  const [pins, setPins] = useState(() =>
    Object.fromEntries(PIN_FIELDS.map(([k]) => [k, String(initial.deployments?.[cluster]?.[k] ?? '')])),
  );
  const { busy, notice, run } = useAction();
  const version = chrome.runtime.getManifest().version;
  // What is saved now, as the form shows it; Save is offered only when something differs.
  const [saved, setSaved] = useState(() => ({
    rpc: initial.rpc?.[cluster] ?? '',
    lockMinutes: String(initial.autoLockMinutes),
    pins: Object.fromEntries(PIN_FIELDS.map(([k]) => [k, String(initial.deployments?.[cluster]?.[k] ?? '')])),
  }));
  const dirty =
    rpc.trim() !== saved.rpc ||
    lockMinutes !== saved.lockMinutes ||
    PIN_FIELDS.some(([k]) => pins[k].trim() !== saved.pins[k]);

  const save = () =>
    run(async () => {
      // Start from what is stored now, so a network switched meanwhile is not undone.
      const next = structuredClone(await getSettings());
      next.autoLockMinutes = Math.min(240, Math.max(1, Math.round(Number(lockMinutes)) || 15));
      if (rpc.trim()) next.rpc[cluster] = rpc.trim();
      else delete next.rpc[cluster];
      if (cluster !== 'mainnet-beta') {
        const entries = Object.entries(pins)
          .map(([k, v]) => [k, v.trim()])
          .filter(([, v]) => v);
        const values = Object.fromEntries(entries);
        if (values.programSize) values.programSize = Number(values.programSize);
        if (entries.length) next.deployments[cluster] = values;
        else delete next.deployments[cluster];
      }
      // Check the endpoint and pins now, so a typo cannot break every screen later.
      const deployment = deploymentFor(next);
      if (isAvailable(deployment)) networkConfig(deployment);
      await saveSettings(next);
      // Re-arm the auto-lock timer now, so it uses the new duration.
      touch();
      setLockMinutes(String(next.autoLockMinutes));
      setSaved({
        rpc: next.rpc[cluster] ?? '',
        lockMinutes: String(next.autoLockMinutes),
        pins: Object.fromEntries(PIN_FIELDS.map(([k]) => [k, String(next.deployments?.[cluster]?.[k] ?? '')])),
      });
      if (rpc.trim() !== (next.rpc[cluster] ?? '')) setRpc(next.rpc[cluster] ?? '');
      return 'Saved.';
    });

  return (
    <>
      <div className="page-heading with-back">
        <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <h1>Settings</h1>
      </div>

      <h2 className="settings-label">Network · {network.label}</h2>
      <div className="setting-panel">
        <Field label="RPC endpoint (optional)" hint={`Leave empty to use ${current.rpc}`}>
          <input
            value={rpc}
            onChange={(e) => setRpc(e.target.value)}
            placeholder={current.rpc}
            spellCheck="false"
            autoComplete="off"
          />
        </Field>
        {cluster !== 'mainnet-beta' ? (
          <details className="pins">
            <summary>
              <Code size={16} />
              <span>Developer deployment pins</span>
              <ChevronRight size={14} className="summary-chevron" />
            </summary>
            <p className="field-hint">
              For devnet or a local validator only. Mainnet pins are fixed by the release.
            </p>
            {PIN_FIELDS.map(([k, label]) => (
              <Field key={k} label={label}>
                <input
                  value={pins[k]}
                  onChange={(e) => setPins((p) => ({ ...p, [k]: e.target.value }))}
                  placeholder={k === 'programSize' ? 'bytes' : 'base58 / hex'}
                  spellCheck="false"
                  autoComplete="off"
                  inputMode={k === 'programSize' ? 'numeric' : undefined}
                />
              </Field>
            ))}
          </details>
        ) : (
          <p className="field-hint">Mainnet deployment pins are fixed by the release.</p>
        )}
      </div>

      <h2 className="settings-label">Security</h2>
      <div className="setting-panel">
        <Field label="Auto-lock after (minutes)" unit="min" hint="Between 1 and 240 minutes of inactivity.">
          <input
            type="number"
            min="1"
            max="240"
            value={lockMinutes}
            onChange={(e) => setLockMinutes(e.target.value)}
          />
        </Field>
      </div>

      <div className="save-row">
        <ActionNotice notice={notice} />
        <ActionButton busy={busy} disabled={!dirty} onClick={save}>
          Save changes
        </ActionButton>
      </div>

      <h2 className="settings-label">Wallet</h2>
      <div className="menu">
        <button type="button" className="menu-row" onClick={onBackup}>
          <Key size={18} />
          <span>
            Back up wallet
            <small>Download your encrypted keys</small>
          </span>
          <ChevronRight size={16} />
        </button>
        <button type="button" className="menu-row" onClick={onLock}>
          <Lock size={18} />
          <span>
            Lock now
            <small>Your passphrase is needed to unlock</small>
          </span>
        </button>
        <button type="button" className="menu-row" onClick={onPassphrase}>
          <Shield size={18} />
          <span>
            Change passphrase
            <small>Re-encrypts your keys on this device</small>
          </span>
          <ChevronRight size={16} />
        </button>
        <button type="button" className="menu-row danger" onClick={onRemove}>
          <Alert size={18} />
          <span>
            Remove from this browser
            <small>Deletes the keys here; restore later from your backup</small>
          </span>
          <ChevronRight size={16} />
        </button>
      </div>

      <p className="about">
        Quantum Seal {version} · transfers approved with SLH-DSA (FIPS 205)
        <br />
        Open it with Alt+Shift+Q (change at chrome://extensions/shortcuts)
        <br />
        Not independently audited.
      </p>
    </>
  );
}

export function BackupPage({ onBack }) {
  const { busy, notice, run } = useAction();
  const download = () =>
    run(async () => {
      const data = await vault.exportBackup();
      const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'quantum-seal-backup.json';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await vault.markBackedUp();
      return 'Backup downloaded. Keep the file and your passphrase somewhere safe.';
    });
  return (
    <>
      <div className="page-heading with-back">
        <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <h1>Backup</h1>
      </div>
      <div className="backup-page">
        <div className="setting-panel prose">
          <p>
            The backup file holds your keys, encrypted with your passphrase, and your public wallet addresses. Keep it
            somewhere safe: anyone with the file and the passphrase controls the wallet.
          </p>
          <p className="field-hint">Developers: the owner key in this file also works with the Quantum Seal command line.</p>
        </div>
        <ActionButton busy={busy} icon={<Download size={16} />} onClick={download}>
          Download backup
        </ActionButton>
        <ActionNotice notice={notice} />
      </div>
    </>
  );
}

function PageHeading({ title, onBack }) {
  return (
    <div className="page-heading with-back">
      <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
        <ArrowLeft size={18} />
      </button>
      <h1>{title}</h1>
    </div>
  );
}

// Passphrase inputs are uncontrolled and cleared after use, as on the welcome screen.
export function PassphrasePage({ onBack, onBackup }) {
  const current = useRef(null);
  const next = useRef(null);
  const repeat = useRef(null);
  const [changed, setChanged] = useState(false);
  const { busy, notice, run } = useAction();
  const change = () =>
    run(async () => {
      const value = next.current.value;
      if ([...value].length < 12) throw new Error('Use a long passphrase of at least 12 characters.');
      if (value !== repeat.current.value) throw new Error('The new passphrases do not match.');
      try {
        await vault.changePassphrase(current.current.value, value);
      } catch (error) {
        if (error?.message === 'Unable to unlock keystore.') {
          current.current.select();
          throw new Error('The current passphrase is wrong.');
        }
        throw error;
      }
      for (const r of [current, next, repeat]) r.current.value = '';
      setChanged(true);
      return 'Passphrase changed.';
    });
  return (
    <>
      <PageHeading title="Change passphrase" onBack={onBack} />
      <div className="form-stack">
        <Field label="Current passphrase">
          <input ref={current} type="password" autoComplete="current-password" autoFocus />
        </Field>
        <Field label="New passphrase (12+ characters)">
          <input ref={next} type="password" autoComplete="new-password" />
        </Field>
        <Field label="Repeat new passphrase">
          <input ref={repeat} type="password" autoComplete="new-password" onKeyDown={(e) => e.key === 'Enter' && change()} />
        </Field>
        <p className="hint">
          <Shield size={14} />
          <span>Backup files you already saved still open with the old passphrase. Save a new backup afterwards.</span>
        </p>
        <ActionButton busy={busy} onClick={change}>
          Change passphrase
        </ActionButton>
        <ActionNotice notice={notice} />
        {changed ? (
          <button type="button" className="secondary full" onClick={onBackup}>
            Back up now
          </button>
        ) : null}
      </div>
    </>
  );
}

// Removing the wallet, from Settings or from the lock screen ("Forgot passphrase?").
export function RemoveWallet({ onRemoved, intro, locked = false }) {
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const open = useLoad(async () => ({ ...(await service.unfinishedSends()), info: await vault.publicInfo() }), []);
  // Never backed up: removing it loses the funds for good, so ask for the word itself.
  const unsaved = open.data?.info && !open.data.info.backedUp;
  const { busy, notice, run } = useAction();
  const remove = () =>
    run(async () => {
      await service.removeWallet({ evenWithUnfinished: true });
      onRemoved();
    });
  const pending = open.data?.count ?? 0;
  return (
    <div className="form-stack remove-wallet">
      <div className="setting-panel prose">
        {intro}
        <p>
          This deletes your keys and send history from this browser. Your funds stay on Solana: restore your backup file
          (with its passphrase) here or in another browser to use them again. <strong>Without the backup, they cannot be
          recovered.</strong>
        </p>
      </div>
      {pending ? (
        <Notice kind="warn">
          {pending} send{pending === 1 ? ' is' : 's are'} not finished
          {open.data.lamports > 0n ? `, holding ${solDisplay(open.data.lamports, 6)} SOL in proof deposits` : ''}. After
          removal {open.data.lamports > 0n ? 'that SOL stays locked in its proof account, and ' : ''}restoring the backup
          does not bring {pending === 1 ? 'it' : 'them'} back.
          {locked ? '' : ` Finish or discard ${pending === 1 ? 'it' : 'them'} in Activity first.`}
        </Notice>
      ) : null}
      {unsaved ? (
        <>
          <Notice kind="error">
            This browser has no record of a backup of this wallet. If you do not have one, removing it loses its funds
            for good.
          </Notice>
          <Field label="Type REMOVE to confirm">
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck="false" />
          </Field>
        </>
      ) : null}
      <label className="check-row">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          {unsaved
            ? 'I understand this wallet and its funds cannot be recovered without a backup.'
            : 'I have my backup file and its passphrase.'}
        </span>
      </label>
      <ActionButton
        className="danger full"
        busy={busy}
        disabled={!ack || open.loading || (unsaved && typed.trim() !== 'REMOVE')}
        onClick={remove}
      >
        Remove wallet from this browser
      </ActionButton>
      <ActionNotice notice={notice} />
    </div>
  );
}

export { PageHeading };

export function RemovePage({ onBack, onRemoved }) {
  return (
    <>
      <PageHeading title="Remove wallet" onBack={onBack} />
      <RemoveWallet onRemoved={onRemoved} />
    </>
  );
}
