// Send: pick an asset, enter recipient and amount, then review in a separate window.
import { useState } from 'react';
import { service, lamportsToSol, errorText, openReview, solDisplay, short } from './common.js';
import { NEEDS_TOKEN_ACCOUNT } from '../wallet-service.js';
import { knownToken, tokenLabel } from '../tokens.js';
import { ActionButton, ActionNotice, Field, Loading, Notice, Sheet, useAction, useLoad } from './components.jsx';
import { ArrowLeft, Check, ChevronDown, Coins, Shield } from './icons.jsx';

export function SendPage({ onBack }) {
  const overview = useLoad(() => service.overview(), []);
  const recent = useLoad(() => service.recentRecipients(), []);
  const [asset, setAsset] = useState('SOL');
  const [picking, setPicking] = useState(false);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const { busy, notice, setNotice, run } = useAction();
  // Set when a token recipient has no account for the token yet: { rentLamports }.
  const [needsAccount, setNeedsAccount] = useState(null);
  // An error about the old input goes away as soon as the input changes.
  const edit = (set) => (value) => {
    set(value);
    setNeedsAccount(null);
    if (notice?.kind === 'error') setNotice(null);
  };
  const o = overview.data;

  // max: the most this send can move (for SOL, what is left after the fee refill).
  const assets = o
    ? [
        {
          id: 'SOL',
          name: 'SOL',
          sub: 'Solana',
          balance: `${lamportsToSol(o.availableLamports)} SOL`,
          max: o.maxSendableLamports > 0n ? lamportsToSol(o.maxSendableLamports) : null,
        },
        // Only classic SPL tokens can be sent in this version.
        ...o.tokens.filter((t) => !t.token2022).map((t) => ({
          id: t.mint,
          name: tokenLabel(o.cluster, t.mint, 5),
          sub: knownToken(o.cluster, t.mint)?.name ?? 'SPL token',
          balance: t.uiAmount,
          max: t.amount !== '0' ? t.uiAmount : null,
          mint: t.mint,
        })),
      ]
    : [];
  const selected = assets.find((a) => a.id === asset) ?? assets[0];

  const prepare = async () => {
    const record = await service.prepareSend({
      asset: asset === 'SOL' ? 'SOL' : 'TOKEN',
      mint: asset === 'SOL' ? undefined : asset,
      to: to.trim(),
      amount: amount.trim(),
    });
    await openReview(record.id);
    return 'Review window opened. Check the details there before you approve.';
  };
  const review = () =>
    run(async () => {
      try {
        return await prepare();
      } catch (error) {
        if (error?.code !== NEEDS_TOKEN_ACCOUNT) throw error;
        setNeedsAccount({ rentLamports: error.rentLamports });
        return null;
      }
    });
  const createAndReview = () =>
    run(async () => {
      await service.createRecipientTokenAccount({ to: to.trim(), mint: asset });
      setNeedsAccount(null);
      return prepare();
    }, 'Creating the recipient’s token account…');

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
                {selected.id === 'SOL' ? 'S' : selected.name.slice(0, 2)}
              </span>
              <span className="token-name">
                <strong>{selected.name}</strong>
                <small>{selected.sub}</small>
              </span>
              <ChevronDown size={16} />
            </button>
          </div>
          <Field label="To">
            <input
              value={to}
              onChange={(e) => edit(setTo)(e.target.value)}
              placeholder="Recipient address"
              spellCheck="false"
              autoComplete="off"
            />
          </Field>
          {!to.trim() && recent.data?.length ? (
            <div className="recent" role="group" aria-label="Recent recipients">
              <span className="field-label">Recent</span>
              <div className="recent-list">
                {recent.data.map((r) => (
                  <button
                    type="button"
                    key={r.address}
                    className="recent-chip"
                    title={r.address}
                    aria-label={`Recent recipient ${r.address}`}
                    onClick={() => edit(setTo)(r.address)}
                  >
                    {short(r.address, 5)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <Field
            label="Amount"
            unit={asset === 'SOL' ? 'SOL' : (knownToken(o?.cluster, asset)?.symbol ?? 'tokens')}
            className="large"
            aside={
              <>
                <span className="available">
                  Available&nbsp;<strong>{selected.balance}</strong>
                </span>
                {selected.max ? (
                  <button
                    type="button"
                    className="max-button"
                    aria-label={`Use the maximum: ${selected.max}`}
                    onClick={() => edit(setAmount)(selected.max)}
                  >
                    Max
                  </button>
                ) : null}
              </>
            }
          >
            <input
              value={amount}
              onChange={(e) => edit(setAmount)(e.target.value)}
              placeholder="Amount"
              inputMode="decimal"
              autoComplete="off"
            />
          </Field>
          <ActionNotice notice={notice} />
          {needsAccount ? (
            <div className="fee-card backup-card" role="status">
              <div className="fee-card-top">
                <span className="fee-icon" aria-hidden="true">
                  <Coins size={18} />
                </span>
                <p>
                  The recipient has no account for this token yet
                  <span>
                    Quantum Seal can open one for them for {solDisplay(needsAccount.rentLamports, 8)} SOL, paid from your
                    fee address. The SOL stays in that account, which the recipient owns.
                  </span>
                </p>
              </div>
              <ActionButton className="secondary" busy={busy} onClick={createAndReview}>
                Pay {solDisplay(needsAccount.rentLamports, 8)} SOL and continue
              </ActionButton>
              <button type="button" className="ghost" disabled={busy} onClick={() => setNeedsAccount(null)}>
                Use a different recipient
              </button>
            </div>
          ) : (
            <ActionButton busy={busy} disabled={!to.trim() || !amount.trim()} onClick={review}>
              Review
            </ActionButton>
          )}
          <p className="hint">
            <Shield size={14} />
            <span>
              {needsAccount
                ? 'Creating the account is signed right away from your fee address. The transfer itself is still reviewed in a separate window.'
                : 'A separate window shows the exact transfer before anything is signed.'}
            </span>
          </p>
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
                edit(setAsset)(a.id);
                setPicking(false);
              }}
            >
              <span className={`token-avatar ${a.id === 'SOL' ? 'sol' : ''}`} aria-hidden="true">
                {a.id === 'SOL' ? 'S' : a.name.slice(0, 2)}
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
