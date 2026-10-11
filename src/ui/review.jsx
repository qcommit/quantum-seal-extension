// Review window (opened by the popup with chrome.windows.create, ~420x720). Shows the
// decoded transfer before signing, then the send's progress through the SDK's steps.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { decodeIntent, fromHex, hex, intentDigest } from 'quantum-seal-wallet/codec';
import { BUILT_IN, explorerUrl } from '../networks.js';
import { tokenLabel } from '../tokens.js';
import { executeSignature, mayStillExecute } from '../wallet-service.js';
import {
  vault,
  service,
  short,
  touch,
  trackActivity,
  errorText,
  friendlyMessage,
  lamportsToSol,
  onStorageChange,
  onSendsChange,
} from './common.js';
import { ActionButton, KeyValue, Loading, Mark, Notice, Spinner, TestNetworkBanner } from './components.jsx';
import { describeIntent, tokenAccountFor } from '../intent.js';
import { Alert, Check, ChevronRight, Close, External, Lock, Shield } from './icons.jsx';

const id = new URLSearchParams(location.search).get('id');
// What the amount above the details means in each state.
const EYEBROW = {
  review: 'You are sending',
  signed: 'Approved, not sent yet',
  submitting: 'Sending',
  done: 'Sent',
  failed: 'Not finished',
  uncertain: 'Sending, waiting for a check',
  notSent: 'Not sent',
};
const CHUNKS = 11;
// Labels the SDK attaches to each transaction, in order. Some transactions combine
// steps (e.g. "upload-chunk+seal-proof+verify-batch-1-8"), so steps match by inclusion.
const STEPS = [
  ['upload-chunk', 'Upload signature', `${CHUNKS} chunks`],
  ['verify-batch', 'Seal and verify on-chain', 'FORS + 7 XMSS layers'],
  ['execute-wallet-transfer', 'Execute transfer', 'and reclaim the deposit'],
];

function stepState(record, key) {
  const has = (r, phase) => r.phase === phase && r.label.includes(key);
  const confirmed = record.records.filter((r) => has(r, 'confirmed'));
  const prepared = record.records.filter((r) => has(r, 'prepared'));
  if (key === 'upload-chunk') return { done: confirmed.length, total: CHUNKS, active: prepared.length > confirmed.length };
  return { done: confirmed.length ? 1 : 0, total: 1, active: prepared.length > confirmed.length };
}

function Progress({ record, live }) {
  return (
    <ol className="steps" aria-label="Progress">
      {STEPS.map(([key, label, detail]) => {
        const s = stepState(record, key);
        const state = s.done >= s.total || record.status === 'done' ? 'done' : s.active || s.done ? 'active' : 'pending';
        return (
          <li key={key} className={state === 'active' && !live ? 'active paused' : state}>
            <span className="step-icon" aria-hidden="true">
              {state === 'done' ? <Check size={14} /> : state === 'active' && live ? <Spinner label="" /> : null}
            </span>
            <span className="step-text">
              <strong>{label}</strong>
              <small>
                {key === 'upload-chunk' && s.done && s.done < s.total ? `${s.done} of ${CHUNKS} chunks` : detail}
              </small>
              {key === 'upload-chunk' && state === 'active' ? (
                <progress max={CHUNKS} value={s.done} aria-label="Uploaded chunks" />
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Review() {
  const [state, setState] = useState({ loading: true });
  const [message, setMessage] = useState(null);
  const [check, setCheck] = useState(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  // Only the newest load may apply, so progress never moves backwards on screen.
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    const record = await service.getSend(id);
    const unlocked = await vault.isUnlocked();
    let view = null;
    if (record) {
      // Everything shown comes from the signed intent bytes; stored display fields are
      // only used where the intent can vouch for them.
      try {
        const bytes = fromHex(record.intentHex);
        view = describeIntent(decodeIntent(bytes), { cluster: record.cluster });
        // Approve signs only if the stored bytes still have this digest.
        view.digest = hex(intentDigest(bytes));
      } catch (error) {
        view = { kind: 'unknown', problems: [`This approval could not be decoded (${errorText(error)}).`] };
      }
      view.feePayer = (await vault.publicInfo())?.feePayer ?? null;
      if (view.fee && view.feePayer && view.fee.to !== view.feePayer)
        view.problems.push('The fee refill in this approval goes to an address that is not your fee address.');
      if (view.kind === 'token') {
        let expected = null;
        try {
          expected = await tokenAccountFor(record.display.to, view.mint);
        } catch {
          /* not a valid address */
        }
        view.recipient = expected === view.destination ? record.display.to : null;
        if (!view.recipient)
          view.problems.push('The recipient address does not match the token account this approval pays.');
      } else if (view.kind === 'sol') view.recipient = view.to;
    }
    if (n === seq.current) setState({ loading: false, record, unlocked, view });
  }, []);
  useEffect(() => {
    reload();
    const offSends = onSendsChange(reload);
    const offLock = onStorageChange(['unlocked'], reload);
    return () => {
      offSends();
      offLock();
    };
  }, [reload]);

  const run = async (sign, digest) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setMessage(null);
    setCheck(null);
    touch();
    try {
      if (sign) {
        setMessage({ kind: 'info', text: 'Signing with your post-quantum key…' });
        await service.approve(id, digest);
        setMessage(null);
      }
      await reload();
      await service.execute(id, () => {
        touch();
        reload();
      });
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) });
    } finally {
      runningRef.current = false;
      setRunning(false);
      await reload();
    }
  };
  const discard = async () => {
    touch();
    setMessage(null);
    try {
      await service.discardSend(id);
      window.close();
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) });
    }
  };
  const checkStatus = async () => {
    touch();
    try {
      const result = await service.checkUncertain(id);
      setCheck({
        kind: 'info',
        text: result?.found
          ? `Found on-chain (${result.confirmation}${result.err ? ', failed' : ''}). Resume to continue from there.`
          : 'Not found on-chain. Resume is safe: the next step is rebuilt from on-chain state.',
      });
    } catch (error) {
      setCheck({ kind: 'error', text: errorText(error) });
    }
  };

  if (state.loading) return <Shell><Loading label="Loading transfer" /></Shell>;
  const { record, unlocked } = state;
  if (!record)
    return (
      <Shell>
        <main className="review-main center">
          <span className="empty-icon warn" aria-hidden="true">
            <Alert size={22} />
          </span>
          <h1>This send no longer exists</h1>
          <p className="muted">It was removed from this browser.</p>
        </main>
        <CloseFooter />
      </Shell>
    );
  if (!unlocked)
    return (
      <Shell network={record.cluster}>
        <main className="review-main center">
          <span className="empty-icon" aria-hidden="true">
            <Lock size={22} />
          </span>
          <h1>Wallet locked</h1>
          <p className="muted">Unlock Quantum Seal from the toolbar. This window updates once it is unlocked.</p>
        </main>
        <CloseFooter />
      </Shell>
    );

  const { view } = state;
  const amount = view.amount ?? '?';
  const unit = view.kind === 'token' ? tokenLabel(record.cluster, view.mint, 6) : view.kind === 'sol' ? 'SOL' : '';
  const network = BUILT_IN[record.cluster]?.label ?? record.cluster;
  const blocked = view.problems.length > 0;
  const inReview = record.status === 'review';
  const execSignature = executeSignature(record);
  const notSent = ['superseded', 'expired', 'discarded'].includes(record.status);
  // Discarded after its approval went out: not provably unsent yet.
  const pending = mayStillExecute(record);

  let footer = null;
  if (inReview)
    footer = (
      <>
        <button type="button" className={blocked ? 'primary' : 'secondary'} disabled={running} onClick={discard}>
          Cancel
        </button>
        <ActionButton className="primary" busy={running} disabled={blocked} onClick={() => run(true, view.digest)}>
          Approve &amp; send
        </ActionButton>
      </>
    );
  else if (record.status === 'uncertain' && !running)
    footer = (
      <>
        <button type="button" className="secondary" onClick={checkStatus}>
          Check status
        </button>
        <button type="button" className="primary" onClick={() => run(false)}>
          Resume
        </button>
      </>
    );
  else if ((record.status === 'failed' || record.status === 'signed') && !running)
    footer = (
      <>
        <button type="button" className="secondary" onClick={discard}>
          Discard
        </button>
        <button type="button" className="primary" onClick={() => run(false)}>
          Resume
        </button>
      </>
    );
  else if (notSent && pending && !running)
    // Kept on purpose until it can no longer run, so there is nothing to remove yet.
    footer = (
      <button type="button" className="primary" onClick={() => window.close()}>
        Close
      </button>
    );
  else if (notSent && !running)
    footer = (
      <>
        <button type="button" className="secondary" onClick={discard}>
          Remove
        </button>
        <button type="button" className="primary" onClick={() => window.close()}>
          Close
        </button>
      </>
    );
  else if (record.status === 'submitting' && !running)
    footer = (
      <button type="button" className="secondary" onClick={() => run(false)}>
        Resume if stalled
      </button>
    );
  else if (record.status === 'done')
    footer = (
      <button type="button" className="secondary" onClick={() => window.close()}>
        Close
      </button>
    );

  return (
    <Shell network={record.cluster}>
      <main className="review-main review-scroll" tabIndex={0} aria-label="Transfer">
        <h1>{inReview ? 'Review transfer' : 'Transfer'}</h1>
        <section className="review-hero" aria-label="Amount">
          <p className="eyebrow">{pending ? 'Discarded' : (EYEBROW[notSent ? 'notSent' : record.status] ?? 'Sending')}</p>
          <p className="review-amount">
            {amount} <small>{unit}</small>
          </p>
          {view.recipient ? <p className="review-to">to {short(view.recipient, 6)}</p> : null}
        </section>

        {record.status === 'done' ? (
          <div className="result ok">
            <span className="result-icon">
              <Check size={20} />
            </span>
            <div>
              <p className="result-title">Sent.</p>
              {record.executedElsewhere ? <p>It was executed by another transaction with your signed approval.</p> : null}
              {execSignature ? (
                <a href={explorerUrl(record.cluster, 'tx', execSignature)} target="_blank" rel="noopener noreferrer">
                  View on Solana Explorer <External size={13} />
                </a>
              ) : null}
            </div>
          </div>
        ) : null}

        {notSent ? (
          <div className={`result ${record.status === 'discarded' && !pending ? 'neutral' : 'warn'}`}>
            <span className="result-icon">
              {record.status === 'discarded' && !pending ? <Close size={18} /> : <Alert size={18} />}
            </span>
            <div>
              <p className="result-title">{pending ? 'Discarded, but it could still run.' : 'Nothing was sent.'}</p>
              <p>
                {record.status === 'superseded'
                  ? 'The wallet moved on (another transfer used this approval’s turn), so this approval can no longer execute. No funds left your wallet for it.'
                  : record.status === 'expired'
                    ? 'This approval expired before it could run. No funds left your wallet for it.'
                    : pending
                      ? `Its signed approval was already published while uploading, so anyone holding it could still execute this transfer until slot ${record.expiry}, unless your wallet sends something else first. Activity shows it as Sent if that happens.`
                      : 'You discarded this send.'}
              </p>
              {record.reclaimSignature ? (
                <p>Its proof deposit ({lamportsToSol(record.reclaimedLamports)} SOL) went back to your fee address.</p>
              ) : record.reclaimError ? (
                <p>Its proof deposit is still held; it is returned automatically the next time you open the wallet.</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {!inReview && !notSent && record.status !== 'done' ? (
          <Progress record={record} live={running} />
        ) : null}

        {record.status === 'uncertain' && !running ? (
          <div className="result warn">
            <span className="result-icon">
              <Alert size={18} />
            </span>
            <div>
              <p>
                The network gave no clear answer for one transaction. Nothing will be re-signed. Check its status before
                resuming.
              </p>
              <code className="address">{record.uncertainSignature ?? ''}</code>
            </div>
          </div>
        ) : null}
        {(record.status === 'failed' || record.status === 'signed') && !running ? (
          <>
            {record.error ? (
              <div className="result error" role="alert">
                <span className="result-icon">
                  <Alert size={18} />
                </span>
                <div>
                  <p className="result-title">This send stopped.</p>
                  <p>{friendlyMessage(record.error)}</p>
                </div>
              </div>
            ) : null}
            <p className="muted small">
              Resume continues from what is already on-chain, with the same signed approval. Discard returns the proof
              deposit to your fee address; the signed approval itself stays valid until slot {record.expiry}.
            </p>
          </>
        ) : null}
        {record.status === 'submitting' ? (
          <p className="muted small">
            {running
              ? 'Sending… keep this window open.'
              : 'Not moving? If this send was interrupted, Resume continues from what is already on-chain.'}
          </p>
        ) : null}
        {check ? <Notice kind={check.kind}>{check.text}</Notice> : null}
        {message ? <Notice kind={message.kind}>{message.text}</Notice> : null}

        {inReview && blocked ? (
          <Notice kind="error">{view.problems.join(' ')} Do not approve it; cancel and prepare the send again.</Notice>
        ) : null}

        <h2 className="card-label" id="details-label">
          Details
        </h2>
        <section className="card review-details" aria-labelledby="details-label">
          {view.amount ? <KeyValue label="Send">{`${amount} ${unit}`}</KeyValue> : null}
          {view.recipient ? (
            <KeyValue label={view.kind === 'token' ? 'To (recipient wallet)' : 'To'} mono>
              {view.recipient}
            </KeyValue>
          ) : null}
          {view.kind === 'token' ? (
            <>
              <KeyValue label="Destination token account" mono>
                {view.destination}
              </KeyValue>
              <KeyValue label="Token mint" mono>
                {view.mint}
              </KeyValue>
            </>
          ) : null}
          <KeyValue label="Network">{network}</KeyValue>
          <KeyValue label="From wallet" mono>
            {view.wallet}
          </KeyValue>
          {view.fee ? (
            view.fee.to === view.feePayer ? (
              <KeyValue label="Fee refill to your fee address">{`${lamportsToSol(view.fee.lamports)} SOL`}</KeyValue>
            ) : (
              <KeyValue label="Fee refill to" mono>{`${lamportsToSol(view.fee.lamports)} SOL → ${view.fee.to}`}</KeyValue>
            )
          ) : null}
          {view.kind === 'sol' && view.lamports !== undefined && view.fee && (inReview || record.status === 'done') ? (
            <KeyValue label="Total from wallet" strong>{`${lamportsToSol(view.lamports + view.fee.lamports)} SOL`}</KeyValue>
          ) : null}
          <KeyValue label="Refundable proof deposit">{`${lamportsToSol(record.refundableRentLamports)} SOL`}</KeyValue>
          <details className="tech-details">
            <summary>
              <span>Technical details</span>
              <ChevronRight size={14} className="summary-chevron" />
            </summary>
            <KeyValue label="Network genesis" mono>
              {view.genesis}
            </KeyValue>
            <KeyValue label="Approval valid until slot">{view.expiry}</KeyValue>
            <KeyValue label="Wallet nonce">{view.nonce}</KeyValue>
          </details>
        </section>

        {inReview ? (
          <p className="hint">
            <Shield size={14} />
            <span>Approving signs exactly these details with your post-quantum key. Any change invalidates the signature.</span>
          </p>
        ) : null}
      </main>
      {footer ? (
        <footer
          className={`review-footer${inReview || (notSent && !pending) || ['uncertain', 'failed', 'signed'].includes(record.status) ? ' two' : ''}`}
        >
          {footer}
        </footer>
      ) : null}
    </Shell>
  );
}

// For screens with nothing left to do here.
function CloseFooter() {
  return (
    <footer className="review-footer">
      <button type="button" className="secondary" onClick={() => window.close()}>
        Close
      </button>
    </footer>
  );
}

function Shell({ network, children }) {
  return (
    <div className="review-shell">
      <header className="app-header review-header">
        <Mark />
        <span className="network-text">
          <strong>Quantum Seal</strong>
          <small>Transfer approval</small>
        </span>
        {network ? <span className={`net-pill net-${network}`}>{BUILT_IN[network]?.label ?? network}</span> : null}
      </header>
      <TestNetworkBanner cluster={network} label={BUILT_IN[network]?.label ?? network} />
      {children}
    </div>
  );
}

trackActivity();
createRoot(document.getElementById('app')).render(<Review />);
