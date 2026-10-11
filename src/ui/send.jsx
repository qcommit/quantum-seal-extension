// Send: pick an asset, enter recipient and amount, then review in a separate window.
import { useState } from 'react';
import { service, lamportsToSol, short, errorText, openReview } from './common.js';
import { ActionNotice, Field, Loading, Notice, Sheet, useAction, useLoad } from './components.jsx';
import { ArrowLeft, Check, ChevronDown, Shield } from './icons.jsx';

export function SendPage({ onBack }) {
  const overview = useLoad(() => service.overview(), []);
  const [asset, setAsset] = useState('SOL');
  const [picking, setPicking] = useState(false);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const { busy, notice, run } = useAction();
  const o = overview.data;

  const assets = o
    ? [
        { id: 'SOL', name: 'SOL', sub: 'Solana', balance: `${lamportsToSol(o.availableLamports)} SOL` },
        ...o.tokens.map((t) => ({ id: t.mint, name: short(t.mint, 5), sub: 'SPL token', balance: t.uiAmount, mint: t.mint })),
      ]
    : [];
  const selected = assets.find((a) => a.id === asset) ?? assets[0];

  const review = () =>
    run(async () => {
      const record = await service.prepareSend({
        asset: asset === 'SOL' ? 'SOL' : 'TOKEN',
        mint: asset === 'SOL' ? undefined : asset,
        to: to.trim(),
        amount: amount.trim(),
      });
      await openReview(record.id);
      return 'Review window opened. Check the details there before you approve.';
    }, 'Preparing the transfer…');

  return (
    <>
      <div className="page-heading with-back">
        <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <h1>Send</h1>
      </div>
      {!o && overview.loading ? <Loading label="Loading balances" /> : null}
      {!o && overview.error ? <Notice kind="error">{errorText(overview.error)}</Notice> : null}
      {o ? (
        <div className="form-stack">
          <div className="field">
            <span className="field-label">Asset</span>
            <button
              type="button"
              className="asset-select"
              aria-label={`Asset: ${selected.name}. Change asset`}
              aria-haspopup="dialog"
              onClick={() => setPicking(true)}
            >
              <span className={`token-avatar ${selected.id === 'SOL' ? 'sol' : ''}`} aria-hidden="true">
                {selected.id === 'SOL' ? 'S' : selected.id.slice(0, 2)}
              </span>
              <span className="token-name">
                <strong>{selected.name}</strong>
                <small>{selected.sub}</small>
              </span>
              <span className="token-value">
                <strong>{selected.balance}</strong>
              </span>
              <ChevronDown size={16} />
            </button>
          </div>
          <Field label="To">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Recipient address"
              spellCheck="false"
              autoComplete="off"
            />
          </Field>
          <Field label="Amount" unit={asset === 'SOL' ? 'SOL' : 'tokens'} className="large">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount"
              inputMode="decimal"
              autoComplete="off"
            />
          </Field>
          <p className="available">
            Available <strong>{selected.balance}</strong>
          </p>
          <p className="hint">
            <Shield size={14} />
            <span>You will see the exact transfer in a separate window before anything is signed.</span>
          </p>
          <button type="button" className="primary full" disabled={busy} onClick={review}>
            Review
          </button>
          <ActionNotice notice={notice} />
        </div>
      ) : null}
      <Sheet open={picking} onClose={() => setPicking(false)} title="Choose asset">
        <div className="wallet-list">
          {assets.map((a) => (
            <button
              type="button"
              key={a.id}
              data-asset={a.id}
              className={`wallet-row${a.id === asset ? ' selected' : ''}`}
              aria-pressed={a.id === asset}
              onClick={() => {
                setAsset(a.id);
                setPicking(false);
              }}
            >
              <span className={`token-avatar ${a.id === 'SOL' ? 'sol' : ''}`} aria-hidden="true">
                {a.id === 'SOL' ? 'S' : a.id.slice(0, 2)}
              </span>
              <span className="token-name">
                <strong title={a.mint}>{a.name}</strong>
                <small>{a.sub}</small>
              </span>
              <span className="token-value">
                <strong>{a.balance}</strong>
              </span>
              {a.id === asset ? <Check size={16} /> : null}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}
