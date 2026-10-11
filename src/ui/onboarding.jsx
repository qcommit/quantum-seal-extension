// Welcome (create or restore) and unlock. Passphrase inputs are uncontrolled and cleared
// after use, so passphrases never sit in React state or in a DOM value attribute.
import { useRef, useState } from 'react';
import { vault } from './common.js';
import { ActionNotice, Mark, useAction } from './components.jsx';
import { Shield, Upload } from './icons.jsx';

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
        <div className="segmented" role="tablist" aria-label="Get started">
          <button type="button" role="tab" aria-selected={mode === 'create'} onClick={() => setMode('create')}>
            New wallet
          </button>
          <button type="button" role="tab" aria-selected={mode === 'restore'} onClick={() => setMode('restore')}>
            From backup
          </button>
        </div>
        {mode === 'create' ? <CreateForm onDone={onDone} /> : <RestoreForm onDone={onDone} />}
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
    }, 'Creating keys…');
  return (
    <div className="form-stack" role="tabpanel">
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
      <button type="button" className="primary full" disabled={busy} onClick={create}>
        Create wallet
      </button>
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
    }, 'Unlocking backup…');
  return (
    <div className="form-stack" role="tabpanel">
      <label className="import-button secondary">
        <Upload size={16} />
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
        <span>Restores the encrypted keys and your wallet addresses from a Quantum Seal backup.</span>
      </p>
      <button type="button" className="primary full" disabled={busy} onClick={restore}>
        Restore
      </button>
      <ActionNotice notice={notice} />
    </div>
  );
}

export function Unlock({ onDone }) {
  const pass = useRef(null);
  const { busy, notice, run } = useAction();
  const unlock = () =>
    run(async () => {
      try {
        await vault.unlock(pass.current.value);
      } catch (error) {
        pass.current.select();
        throw error;
      }
      pass.current.value = '';
      onDone();
    }, 'Unlocking…');
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
          <button type="button" className="primary full" disabled={busy} onClick={unlock}>
            Unlock
          </button>
          <ActionNotice notice={notice} />
        </div>
      </main>
      <p className="gate-foot">Locks itself after a period of inactivity.</p>
    </div>
  );
}
