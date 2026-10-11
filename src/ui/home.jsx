// Home tab (setup, balance, fee key, tokens) and the Activity tab.
import { useEffect, useState } from 'react';
import { BUILT_IN, explorerUrl } from '../networks.js';
import { FEE_FLOAT_LAMPORTS } from '../wallet-service.js';
import {
  vault,
  service,
  lamportsToSol,
  solDisplay,
  short,
  errorText,
  openReview,
  onSendsChange,
} from './common.js';
import {
  ActionButton,
  ActionNotice,
  CopyButton,
  Empty,
  Loading,
  Notice,
  QrCode,
  TestAddressCaption,
  useAction,
  useLoad,
} from './components.jsx';
import {
  Alert,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Clock,
  Close,
  Coins,
  Copy,
  Check,
  External,
  Fuel,
  Inbox,
  Refresh,
  SendArrow,
  Shield,
} from './icons.jsx';

// Setup keeps a fee float on the setup address; anything above it moves into the wallet.
export const SETUP_MINIMUM_LAMPORTS = FEE_FLOAT_LAMPORTS + 10000000n;

// Shown until a backup is saved: with no seed phrase, the backup file is the only way to
// restore this wallet if the browser profile is lost.
function BackupReminder({ reloadKey, onBackup }) {
  const info = useLoad(() => vault.publicInfo(), [reloadKey]);
  if (!info.data || info.data.backedUp) return null;
  return (
    <div className="fee-card backup-card" role="status">
      <div className="fee-card-top">
        <span className="fee-icon" aria-hidden="true">
          <Shield size={18} />
        </span>
        <p>
          Back up your wallet
          <span>There is no seed phrase. Your backup file is the only way to restore this wallet if this browser is lost.</span>
        </p>
      </div>
      <button type="button" className="secondary" onClick={onBackup}>
        Back up now
      </button>
    </div>
  );
}

export function HomeTab({ reloadKey, onInitialized, onReceive, onSend, onSettings, onBackup }) {
  const [poll, setPoll] = useState(0);
  const setup = useAction();
  const sweep = useAction();
  const topUp = useAction();
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

  if (!o && overview.loading) return <HomeSkeleton />;
  if (!o)
    return (
      <div className="empty load-error">
        <span className="empty-icon warn" aria-hidden="true">
          <Alert size={22} />
        </span>
        <h1 className="empty-title">Could not load this network</h1>
        <Notice kind="error">{errorText(overview.error)}</Notice>
        <p>Try again, pick another network from the header, or check the RPC endpoint in Settings.</p>
        <div className="row-actions">
          <ActionButton
            className="secondary"
            busy={overview.loading}
            icon={<Refresh size={16} />}
            onClick={() => setPoll((p) => p + 1)}
          >
            Try again
          </ActionButton>
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
        reminder={<BackupReminder reloadKey={reloadKey} onBackup={onBackup} />}
      />
    );

  const lowFees = o.feeLamports < o.feeNeededLamports;
  const swept = o.sweepableLamports > 0n;
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

      <div className="home-status">
        <BackupReminder reloadKey={reloadKey} onBackup={onBackup} />
        {overview.error ? <Notice kind="error">{errorText(overview.error)}</Notice> : null}
        {lowFees ? (
          <div className="fee-card" role="status">
            <div className="fee-card-top">
              <span className="fee-icon" aria-hidden="true">
                <Fuel size={18} />
              </span>
              <p>
                Add SOL to your fee address to send
                <span>
                  It holds {solDisplay(o.feeLamports, 6)} SOL; a send needs about {solDisplay(o.feeNeededLamports, 3)} SOL
                  there. Send SOL to it from any wallet or exchange.
                </span>
              </p>
            </div>
            <code className="address">{o.feePayer}</code>
            <CopyButton text={o.feePayer} label="Copy fee address" />
            <TestAddressCaption cluster={o.cluster} />
          </div>
        ) : o.topUpLamports > 0n ? (
          <div className="fee-card" role="status">
            <div className="fee-card-top">
              <span className="fee-icon" aria-hidden="true">
                <Fuel size={18} />
              </span>
              <p>
                Fee address is running low
                <span>
                  {solDisplay(o.feeLamports, 6)} SOL left of {solDisplay(FEE_FLOAT_LAMPORTS, 3)} SOL. Move{' '}
                  {solDisplay(o.topUpLamports, 6)} SOL from your wallet; you review it like any send.
                </span>
              </p>
            </div>
            <ActionButton
              className="secondary"
              busy={topUp.busy}
              onClick={() =>
                topUp.run(async () => {
                  const record = await service.topUpFeeKey();
                  await openReview(record.id);
                  return 'Review window opened.';
                })
              }
            >
              Top up from wallet
            </ActionButton>
          </div>
        ) : swept ? null : (
          <p className="status-line">
            <Fuel size={16} />
            <span className="status-text">
              <b>Fees ready</b> · {solDisplay(o.feeLamports)} SOL on your fee address
            </span>
            <span className="status-dot" aria-hidden="true" />
          </p>
        )}
        <ActionNotice notice={topUp.notice} />

        {swept ? (
          <div className="fee-card" role="status">
            <div className="fee-card-top">
              <span className="fee-icon" aria-hidden="true">
                <Fuel size={18} />
              </span>
              <p>
                {solDisplay(o.sweepableLamports, 6)} SOL is waiting on your fee address
                <span>Fees need only {solDisplay(FEE_FLOAT_LAMPORTS, 3)} SOL there. Move the rest into your wallet.</span>
              </p>
            </div>
            <ActionButton
              className="secondary"
              busy={sweep.busy}
              onClick={() =>
                sweep.run(async () => {
                  await service.sweepExcess();
                  setPoll((p) => p + 1);
                  return 'Moved into your wallet.';
                })
              }
            >
              Move to wallet
            </ActionButton>
          </div>
        ) : null}
        {/* Outside the card: it stays after the card disappears once the SOL has moved. */}
        <ActionNotice notice={sweep.notice} />
        {o.otherWallets?.length ? (
          <Notice kind="warn">
            An earlier {o.label} wallet of yours still holds{' '}
            {o.otherWallets.map((w) => `${solDisplay(w.lamports)} SOL at ${short(w.wallet, 5)}`).join(', ')}. It belongs
            to a previous deployment of the wallet program; to move it, use a build pinned to that deployment (program{' '}
            {short(o.otherWallets[0].program, 5)}).
          </Notice>
        ) : null}
      </div>

      <div className="section-heading">
        <h2>Tokens</h2>
        <span aria-label={`${o.tokens.length} tokens`}>{o.tokens.length}</span>
      </div>
      {o.tokens.length ? (
        <ul className="token-list" aria-label="Tokens">
          {o.tokens.map((t) => (
            <li className="token-row" key={t.account}>
              <span className="token-avatar" aria-hidden="true">
                {t.mint.slice(0, 2)}
              </span>
              <span className="token-name">
                <strong title={t.mint}>{short(t.mint, 5)}</strong>
                <small>SPL token</small>
              </span>
              <span className="token-value">
                <strong title={t.uiAmount}>{t.uiAmount}</strong>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty compact icon={<Coins size={18} />} title="No tokens yet">
          <p>Classic SPL tokens sent to your wallet address show up here.</p>
        </Empty>
      )}
    </>
  );
}

// Same footprint as the loaded balance and actions, so nothing jumps when data arrives.
function HomeSkeleton() {
  return (
    <div className="home-skeleton" role="status">
      <h1 className="visually-hidden">Loading balance</h1>
      <div className="balance-hero">
        <div className="skeleton-hero">
          <span className="skeleton sk-eyebrow" />
          <span className="skeleton sk-amount" />
          <span className="skeleton sk-chip" />
        </div>
      </div>
      <div className="actions" aria-hidden="true">
        <span className="skeleton action" />
        <span className="skeleton action" />
      </div>
      <span className="skeleton sk-line" />
    </div>
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

function Setup({ o, action, refreshing, onRefresh, error, reminder }) {
  const enough = o.feeLamports >= SETUP_MINIMUM_LAMPORTS;
  return (
    <div className="setup">
      <div className="page-heading">
        <h1>Set up your wallet</h1>
        <p>
          Send at least {lamportsToSol(SETUP_MINIMUM_LAMPORTS)} SOL to this address on <strong>{o.label}</strong>. It
          becomes your fee address: {lamportsToSol(FEE_FLOAT_LAMPORTS)} SOL stays here for network fees and the rest
          moves into your new wallet.
        </p>
      </div>
      <div className="setup-balance" aria-live="polite">
        <span>
          Balance at this address
          <strong>{lamportsToSol(o.feeLamports)} SOL</strong>
        </span>
        <span className={`pill ${enough ? 'done' : 'review'}`}>{enough ? 'Ready' : 'Waiting'}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh"
          title="Refresh"
          disabled={action.busy || refreshing}
          onClick={onRefresh}
        >
          {refreshing ? <span className="btn-spinner" aria-hidden="true" /> : <Refresh size={16} />}
        </button>
      </div>
      {error ? <Notice kind="error">{errorText(error)}</Notice> : null}
      {reminder}
      {enough ? (
        <>
          <ActionButton
            busy={action.busy}
            onClick={() =>
              action.run(async () => {
                await service.setupWallet();
                onRefresh();
              }, 'Creating your wallet on-chain. This takes a few seconds…')
            }
          >
            Create my wallet
          </ActionButton>
          <ActionNotice notice={action.notice} />
        </>
      ) : null}
      <div className="address-card">
        <QrCode text={o.feePayer} />
        <code className="address">{o.feePayer}</code>
        <TestAddressCaption cluster={o.cluster} />
        <CopyButton text={o.feePayer} />
      </div>
      {enough ? null : (
        <p className="hint">
          <Clock size={14} />
          <span>Checking for your deposit every few seconds. You can close this window meanwhile.</span>
        </p>
      )}
    </div>
  );
}

const STATUS_LABEL = {
  review: 'In review',
  signed: 'Approved',
  submitting: 'Sending',
  done: 'Sent',
  failed: 'Failed',
  uncertain: 'Uncertain',
  superseded: 'Not sent',
  expired: 'Expired',
  discarded: 'Discarded',
};
const STATUS_ICON = { failed: Alert, uncertain: Alert, superseded: Close, expired: Clock, discarded: Close };

export function ActivityTab() {
  const [version, setVersion] = useState(0);
  useEffect(() => onSendsChange(() => setVersion((v) => v + 1)), []);
  const sends = useLoad(() => service.listSends(), [version]);
  // Read from chain history: slower, and a failure here must not hide the sends.
  const receipts = useLoad(() => service.listReceipts(), []);
  const items = [
    ...(sends.data ?? []).map((s) => ({ kind: 'send', key: s.id, at: s.createdAt, s })),
    ...(receipts.data ?? []).map((r) => ({ kind: 'receipt', key: r.id, at: r.at, r })),
  ].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const settled = sends.data && (receipts.data || receipts.error);
  return (
    <>
      <div className="page-heading">
        <h1>Activity</h1>
        <p>Transfers in and out of this wallet. Open a send for details, or to resume it.</p>
      </div>
      {sends.loading && !sends.data ? <Loading label="Loading activity" /> : null}
      {sends.error ? <Notice kind="error">{errorText(sends.error)}</Notice> : null}
      {receipts.error ? <Notice kind="warn">Received transfers could not be loaded: {errorText(receipts.error)}</Notice> : null}
      {settled && !items.length ? (
        <Empty level={2} icon={<Inbox size={22} />} title="No activity yet">
          <p>Transfers to and from this wallet appear here.</p>
        </Empty>
      ) : null}
      {items.length ? (
        <ul className="activity-list">
          {items.map((item) => (
            <li key={item.key}>{item.kind === 'send' ? <SendRow s={item.s} /> : <ReceiptRow r={item.r} />}</li>
          ))}
        </ul>
      ) : null}
      {sends.data && receipts.loading && !receipts.data ? (
        <p className="hint activity-checking">
          <span className="btn-spinner" aria-hidden="true" />
          <span>Checking for received transfers…</span>
        </p>
      ) : null}
    </>
  );
}

function SendRow({ s }) {
  const Icon = STATUS_ICON[s.status] ?? SendArrow;
  const asset = s.display.asset === 'SOL' ? 'SOL' : short(s.display.asset);
  return (
    <button type="button" className="activity-row" onClick={() => openReview(s.id)}>
      <span className={`trade-avatar ${s.status}`} aria-hidden="true">
        <Icon size={17} />
      </span>
      <span className="token-name">
        <strong>
          Send {s.display.amount} {asset}
        </strong>
        <small>
          To {short(s.display.to)} · {BUILT_IN[s.cluster]?.label ?? s.cluster} · {when(s.createdAt)}
        </small>
      </span>
      <span className={`pill ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
      <ChevronRight size={16} className="row-chevron" />
    </button>
  );
}

function ReceiptRow({ r }) {
  const asset = r.asset === 'SOL' ? 'SOL' : short(r.asset);
  const from = r.fromFeeAddress ? 'your fee address' : short(r.from);
  return (
    <a
      className="activity-row"
      href={explorerUrl(r.cluster, 'tx', r.signature)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Received ${r.amount} ${asset} from ${from}. View on Solana Explorer`}
    >
      <span className="trade-avatar received" aria-hidden="true">
        <ArrowDown size={17} />
      </span>
      <span className="token-name">
        <strong title={r.asset === 'SOL' ? undefined : r.asset}>
          Received {r.amount} {asset}
        </strong>
        <small>
          From {from} · {BUILT_IN[r.cluster]?.label ?? r.cluster}
          {r.at ? ` · ${when(r.at)}` : ''}
        </small>
      </span>
      <span className="pill received">Received</span>
      <External size={14} className="row-chevron" />
    </a>
  );
}

function when(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
