// Welcome (create or restore) and unlock. Passphrase inputs are uncontrolled and cleared
// after use, so passphrases never sit in React state or in a DOM value attribute.
import { useRef, useState } from 'react';
import { vault } from './common.js';
import { ActionButton, ActionNotice, Mark, useAction } from './components.jsx';
import { PageHeading, RemoveWallet } from './settings.jsx';
import { Check, Shield, Upload } from './icons.jsx';

const MIN_PASSPHRASE = 12;

export function Welcome({ onDone }) {
  const [mode, setMode] = useState('create');
  return (
    <div className="gate">
      <main className="gate-body">
        <div className="gate-hero">
          <Mark size="lg" />
          <p className="gate-name">Quantum Seal</p>
          <h1>A post-quantum wallet for Solana</h1>
          <p className="gate-copy">
            Your keys are created and encrypted on this device. Transfers are approved with SLH-DSA (FIPS 205).
          </p>
        </div>
        {/* Tabs: arrow keys move between them; only the selected one is in the tab order. */}
        <div
          className="segmented"
          role="tablist"
          aria-label="Get started"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const next = mode === 'create' ? 'restore' : 'create';
            setMode(next);
            e.currentTarget.querySelector(`#tab-${next}`)?.focus();
          }}
        >
          {[
            ['create', 'New wallet'],
            ['restore', 'From backup'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-controls="welcome-panel"
              aria-selected={mode === id}
              tabIndex={mode === id ? 0 : -1}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === 'create' ? <CreateForm onDone={onDone} /> : <RestoreForm onDone={onDone} />}
        <p className="hint gate-note">
          <Shield size={14} />
          <span>
            No seed phrase: you save an encrypted backup file instead. Recovery phrases from other wallets cannot be
            imported.
          </span>
        </p>
      </main>
    </div>
  );
}

function CreateForm({ onDone }) {
  const pass = useRef(null);
  const confirm = useRef(null);
  const { busy, notice, run } = useAction();
  const create = () =>
    run(async () => {
      const value = pass.current.value;
      if ([...value].length < MIN_PASSPHRASE)
        throw new Error(`Use a long passphrase of at least ${MIN_PASSPHRASE} characters.`);
      if (value !== confirm.current.value) throw new Error('Passphrases do not match.');
      await vault.create(value);
      pass.current.value = '';
      confirm.current.value = '';
      onDone();
    });
  return (
    <div className="form-stack" role="tabpanel" id="welcome-panel" aria-labelledby="tab-create">
      <input
        ref={pass}
        className="text-input"
        type="password"
        aria-label="New passphrase"
        placeholder="Passphrase (12+ characters)"
        autoComplete="new-password"
        autoFocus
      />
      <input
        ref={confirm}
        className="text-input"
        type="password"
        aria-label="Repeat passphrase"
        placeholder="Repeat passphrase"
        autoComplete="new-password"
        onKeyDown={(e) => e.key === 'Enter' && create()}
      />
      <p className="hint">
        <Shield size={14} />
        <span>The passphrase encrypts your keys here. Nobody can recover it for you.</span>
      </p>
      <ActionButton busy={busy} onClick={create}>
        Create wallet
      </ActionButton>
      <ActionNotice notice={notice} />
    </div>
  );
}

function RestoreForm({ onDone }) {
  const file = useRef(null);
  const pass = useRef(null);
  const [fileName, setFileName] = useState('');
  const { busy, notice, run } = useAction();
  const restore = () =>
    run(async () => {
      const f = file.current.files?.[0];
      if (!f) throw new Error('Choose a backup file.');
      await vault.importBackup(await f.text(), pass.current.value);
      pass.current.value = '';
      onDone();
    });
  return (
    <div className="form-stack" role="tabpanel" id="welcome-panel" aria-labelledby="tab-restore">
      <label className={`import-button secondary${fileName ? ' chosen' : ''}`}>
        {fileName ? <Check size={16} /> : <Upload size={16} />}
        <span>{fileName || 'Choose backup file'}</span>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          aria-label="Backup file"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? '')}
        />
      </label>
      <input
        ref={pass}
        className="text-input"
        type="password"
        aria-label="Backup passphrase"
        placeholder="Backup passphrase"
        autoComplete="current-password"
        onKeyDown={(e) => e.key === 'Enter' && restore()}
      />
      <p className="hint">
        <Shield size={14} />
        <span>Restores your encrypted keys and wallet addresses from a Quantum Seal backup file.</span>
      </p>
      <ActionButton busy={busy} onClick={restore}>
        Restore wallet
      </ActionButton>
      <ActionNotice notice={notice} />
    </div>
  );
}

export function Unlock({ onDone }) {
  const [forgot, setForgot] = useState(false);
  if (forgot)
    return (
      <div className="gate">
        <main className="gate-body">
          <PageHeading title="Forgot your passphrase?" onBack={() => setForgot(false)} />
          <RemoveWallet
            locked
            onRemoved={onDone}
            intro={<p>Nobody can recover a passphrase, including Quantum Seal.</p>}
          />
        </main>
      </div>
    );
  return <UnlockForm onDone={onDone} onForgot={() => setForgot(true)} />;
}

function UnlockForm({ onDone, onForgot }) {
  const pass = useRef(null);
  const { busy, notice, run } = useAction();
  const unlock = () =>
    run(async () => {
      try {
        await vault.unlock(pass.current.value);
      } catch (error) {
        pass.current.select();
        // The vault reports any failed decryption this way; for a person it means the passphrase.
        if (error?.message === 'Unable to unlock keystore.')
          throw new Error('Wrong passphrase. Check it and try again.');
        throw error;
      }
      pass.current.value = '';
      onDone();
    });
  return (
    <div className="gate">
      <main className="gate-body gate-center">
        <div className="gate-hero">
          <Mark size="lg" />
          <h1>Welcome back</h1>
          <p className="gate-copy">Enter your passphrase to unlock Quantum Seal.</p>
        </div>
        <div className="form-stack">
          <input
            ref={pass}
            className="text-input"
            type="password"
            aria-label="Passphrase"
            placeholder="Passphrase"
            autoComplete="current-password"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && unlock()}
          />
          <ActionButton busy={busy} onClick={unlock}>
            Unlock
          </ActionButton>
          <ActionNotice notice={notice} />
          <button type="button" className="link-button" onClick={onForgot}>
            Forgot passphrase?
          </button>
        </div>
      </main>
      <footer className="gate-foot">Quantum Seal locks itself after a period of inactivity.</footer>
    </div>
  );
}
