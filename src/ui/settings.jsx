// Settings (RPC override, auto-lock, developer pins, backup, lock) and the backup page.
import { useState } from 'react';
import { BUILT_IN, deploymentFor } from '../networks.js';
import { vault, getSettings, saveSettings, touch } from './common.js';
import { ActionNotice, Field, Loading, useAction, useLoad } from './components.jsx';
import { ArrowLeft, ChevronRight, Code, Download, Key, Lock } from './icons.jsx';

const PIN_FIELDS = [
  ['program', 'Program address'],
  ['programSha256', 'Program SHA-256'],
  ['programSize', 'Program size (bytes)'],
  ['upgradeAuthority', 'Upgrade authority'],
  ['genesis', 'Genesis hash'],
];

export function SettingsPage({ onBack, onBackup, onLock }) {
  const loaded = useLoad(() => getSettings(), []);
  if (!loaded.data) return <Loading label="Loading settings" />;
  return <SettingsForm initial={loaded.data} onBack={onBack} onBackup={onBackup} onLock={onLock} />;
}

function SettingsForm({ initial, onBack, onBackup, onLock }) {
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
      await saveSettings(next);
      // Re-arm the auto-lock timer now, so it uses the new duration.
      touch();
      setLockMinutes(String(next.autoLockMinutes));
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
        <button type="button" className="primary full" disabled={busy} onClick={save}>
          Save
        </button>
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
          <ChevronRight size={16} />
        </button>
      </div>

      <p className="about">
        Quantum Seal {version} · Not independently audited.
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
      return 'Backup downloaded.';
    });
  return (
    <>
      <div className="page-heading with-back">
        <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <h1>Backup</h1>
      </div>
      <div className="setting-panel prose">
        <p>
          The backup file holds your keys encrypted with your passphrase, plus your public wallet addresses. Keep it
          somewhere safe: anyone with the file and the passphrase controls the wallet.
        </p>
        <p className="field-hint">The owner key inside also opens with the Quantum Seal command line.</p>
      </div>
      <button type="button" className="primary full" disabled={busy} onClick={download}>
        <Download size={16} />
        <span>Download backup</span>
      </button>
      <ActionNotice notice={notice} />
    </>
  );
}
