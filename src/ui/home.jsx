// Home tab (setup, balance, fee key, tokens) and the Activity tab.
import { useEffect, useState } from 'react';
import { BUILT_IN } from '../networks.js';
import { FEE_FLOAT_LAMPORTS } from '../wallet-service.js';
import {
  service,
  lamportsToSol,
  solDisplay,
  short,
  errorText,
  openReview,
  onSendsChange,
} from './common.js';
import { ActionNotice, CopyButton, Loading, Notice, QrCode, useAction, useLoad } from './components.jsx';
import {
  Alert,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Coins,
  Copy,
  Check,
  Fuel,
  Inbox,
  Refresh,
  SendArrow,
  Shield,
} from './icons.jsx';

// Setup keeps a fee float on the setup address; anything above it moves into the wallet.
export const SETUP_MINIMUM_LAMPORTS = FEE_FLOAT_LAMPORTS + 10000000n;

export function HomeTab({ reloadKey, onInitialized, onReceive, onSend, onSettings }) {
  const [poll, setPoll] = useState(0);
  const setup = useAction();
  const sweep = useAction();
  const overview = useLoad(() => service.overview(), [reloadKey, poll]);
  const o = overview.data;
  const initialized = o?.initialized;

  useEffect(() => {
    if (initialized !== undefined) onInitialized(initialized);
  }, [initialized, onInitialized]);
  // While waiting for the setup deposit, check the balance every few seconds. Never while
  // the on-chain setup runs: a half-finished setup must not paint the home screen.
  useEffect(() => {
    if (initialized !== false || setup.busy) return undefined;
    const t = setInterval(() => setPoll((p) => p + 1), 6000);
    return () => clearInterval(t);
  }, [initialized, setup.busy]);

  if (!o && overview.loading) return <Loading label="Loading balance" />;
  if (!o)
    return (
      <div className="empty">
        <span className="empty-icon warn">
          <Alert size={22} />
        </span>
        <h3>Could not load this network</h3>
        <Notice kind="error">{errorText(overview.error)}</Notice>
        <p>Choose an available network or check the RPC endpoint in Settings.</p>
        <div className="row-actions">
          <button type="button" className="secondary" onClick={() => setPoll((p) => p + 1)}>
            <Refresh size={16} />
            <span>Try again</span>
          </button>
          <button type="button" className="secondary" onClick={onSettings}>
            Settings
          </button>
        </div>
      </div>
    );
  if (!o.initialized)
    return (
      <Setup
        o={o}
        action={setup}
        refreshing={overview.loading}
        onRefresh={() => setPoll((p) => p + 1)}
        error={overview.error}
      />
    );

  const lowFees = o.feeLamports < o.feeNeededLamports;
  return (
    <>
      <section className="balance-hero balance" aria-label="Balance">
        <p className="eyebrow">Available balance</p>
        <h1 title={`${lamportsToSol(o.availableLamports)} SOL`}>
          <span className="amount">{solDisplay(o.availableLamports)}</span>
          <small>SOL</small>
        </h1>
        <WalletChip address={o.wallet} />
      </section>
      {overview.error ? <Notice kind="error">{errorText(overview.error)}</Notice> : null}

      <div className="actions">
        <button type="button" className="action" onClick={onReceive}>
          <ArrowDown size={22} />
          <span>Receive</span>
        </button>
        <button type="button" className="action" onClick={onSend}>
          <ArrowUp size={22} />
          <span>Send</span>
        </button>
      </div>

      {o.sweepableLamports > 0n ? (
        <div className="fee-card low" role="status">
          <div className="fee-card-top">
            <span className="fee-icon">
              <Fuel size={18} />
            </span>
            <p>
              {solDisplay(o.sweepableLamports, 6)} SOL is waiting on your fee address
              <span>
                Fees need only {solDisplay(FEE_FLOAT_LAMPORTS, 3)} SOL there. Move the rest into your wallet.
              </span>
            </p>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={sweep.busy}
            onClick={() =>
              sweep.run(async () => {
                await service.sweepExcess();
                setPoll((p) => p + 1);
                return 'Moved into your wallet.';
              }, 'Moving SOL into your wallet…')
            }
          >
            Move to wallet
          </button>
        </div>
      ) : null}
      {/* Outside the card: it disappears once the SOL has moved. */}
      <ActionNotice notice={sweep.notice} />
      {o.otherWallets?.length ? (
        <Notice kind="warn">
          An earlier {o.label} wallet of yours still holds{' '}
          {o.otherWallets.map((w) => `${solDisplay(w.lamports)} SOL at ${short(w.wallet, 5)}`).join(', ')}. It belongs to a
          previous deployment of the wallet program; to move it, use a build pinned to that deployment (program{' '}
          {short(o.otherWallets[0].program, 5)}).
        </Notice>
      ) : null}

      {lowFees ? (
        <div className="fee-card low" role="status">
          <div className="fee-card-top">
            <span className="fee-icon">
              <Fuel size={18} />
            </span>
            <p>
              Fee key is low: {solDisplay(o.feeLamports, 6)} SOL
              <span>
                Send a little SOL (about {solDisplay(o.feeNeededLamports, 3)} SOL) to your fee key so transfers can
                start.
              </span>
            </p>
          </div>
          <code className="mono">{o.feePayer}</code>
          <CopyButton text={o.feePayer} label="Copy fee-key address" />
        </div>
      ) : (
        <div className="fee-card ok">
          <span className="fee-icon">
            <Fuel size={18} />
          </span>
          <p>
            Fee key topped up
            <span>{solDisplay(o.feeLamports)} SOL · refilled by each send</span>
          </p>
          <span className="status-dot" aria-hidden="true" />
        </div>
      )}

      <div className="assurance">
        <Shield size={20} />
        <p>
          Post-quantum signatures
          <span>Every transfer is approved with SLH-DSA (FIPS 205) and checked on-chain.</span>
        </p>
      </div>

      <div className="section-heading">
        <h2>Tokens</h2>
        <span>{o.tokens.length}</span>
      </div>
      {o.tokens.length ? (
        <div className="token-list">
          {o.tokens.map((t) => (
            <div className="token-row" key={t.account}>
              <span className="token-avatar" aria-hidden="true">
                {t.mint.slice(0, 2)}
              </span>
              <span className="token-name">
                <strong title={t.mint}>{short(t.mint, 5)}</strong>
                <small>SPL token</small>
              </span>
              <span className="token-value">
                <strong>{t.uiAmount}</strong>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">
          <span className="empty-icon">
            <Coins size={22} />
          </span>
          <h3>No tokens yet</h3>
          <p>Classic SPL tokens sent to your wallet address show up here.</p>
        </div>
      )}
    </>
  );
}

function WalletChip({ address }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="chip"
      aria-label={copied ? 'Wallet address copied' : 'Copy wallet address'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      <span>{short(address, 5)}</span>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function Setup({ o, action, refreshing, onRefresh, error }) {
  const enough = o.feeLamports >= SETUP_MINIMUM_LAMPORTS;
  return (
    <div className="setup">
      <div className="page-heading">
        <h1>Set up your wallet</h1>
        <p>
          Watching <strong>{o.label}</strong>.{' '}
          Send at least {lamportsToSol(SETUP_MINIMUM_LAMPORTS)} SOL to this setup address. The extension creates your
          post-quantum wallet, keeps {lamportsToSol(FEE_FLOAT_LAMPORTS)} SOL here for network fees, and moves everything
          else into the wallet.
        </p>
      </div>
      <div className="address-card">
        <QrCode text={o.feePayer} />
        <code className="address">{o.feePayer}</code>
        <CopyButton text={o.feePayer} />
      </div>
      <div className="setup-balance">
        <span>
          Setup address balance
          <strong>{lamportsToSol(o.feeLamports)} SOL</strong>
        </span>
        <span className={`pill ${enough ? 'done' : 'review'}`}>{enough ? 'Ready' : 'Waiting'}</span>
      </div>
      {enough ? (
        <button
          type="button"
          className="primary full"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              await service.setupWallet();
              onRefresh();
            }, 'Creating your wallet on-chain…')
          }
        >
          Create my wallet
        </button>
      ) : (
        <Notice kind="info">Waiting for at least {lamportsToSol(SETUP_MINIMUM_LAMPORTS)} SOL.</Notice>
      )}
      <button type="button" className="ghost full" disabled={action.busy || refreshing} onClick={onRefresh}>
        <Refresh size={15} />
        <span>Refresh</span>
      </button>
      <ActionNotice notice={action.notice} />
      {error ? <Notice kind="error">{errorText(error)}</Notice> : null}
    </div>
  );
}

const STATUS_LABEL = {
  review: 'In review',
  signed: 'Signed',
  submitting: 'Submitting',
  done: 'Done',
  failed: 'Failed',
  uncertain: 'Uncertain',
  superseded: 'Not sent',
  expired: 'Expired',
  discarded: 'Discarded',
};

export function ActivityTab() {
  const [version, setVersion] = useState(0);
  useEffect(() => onSendsChange(() => setVersion((v) => v + 1)), []);
  const sends = useLoad(() => service.listSends(), [version]);
  const list = sends.data ?? [];
  return (
    <>
      <div className="page-heading">
        <h1>Activity</h1>
        <p>Sends from this browser. Open one to see its details or resume it.</p>
      </div>
      {sends.loading && !sends.data ? <Loading label="Loading activity" /> : null}
      {sends.error ? <Notice kind="error">{errorText(sends.error)}</Notice> : null}
      {sends.data && !list.length ? (
        <div className="empty">
          <span className="empty-icon">
            <Inbox size={22} />
          </span>
          <h3>No activity yet</h3>
          <p>Transfers you send from this wallet appear here with their status.</p>
        </div>
      ) : null}
      {list.length ? (
        <ul className="activity-list">
          {list.map((s) => (
            <li key={s.id}>
              <button type="button" className="activity-row" onClick={() => openReview(s.id)}>
                <span className={`trade-avatar ${s.status}`} aria-hidden="true">
                  <SendArrow size={18} />
                </span>
                <span className="token-name">
                  <strong>
                    Send {s.display.amount} {s.display.asset === 'SOL' ? 'SOL' : short(s.display.asset)}
                  </strong>
                  <small>
                    To {short(s.display.to)} · {BUILT_IN[s.cluster]?.label ?? s.cluster} · {when(s.createdAt)}
                  </small>
                </span>
                <span className={`pill ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                <ChevronRight size={16} className="row-chevron" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function when(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
