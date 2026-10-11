import { cloneElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { errorText, touch } from './common.js';
import { Alert, Check, Close, Copy } from './icons.jsx';

// Loads async data for a component. Results of a load that was superseded (deps changed)
// or whose component unmounted are dropped, so a slow request can never paint over a
// newer screen such as the lock screen. Earlier data stays visible while reloading.
export function useLoad(fn, deps) {
  const [state, setState] = useState({ loading: true, data: undefined, error: null });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve()
      .then(fn)
      .then(
        (data) => live && setState({ loading: false, data, error: null }),
        (error) => live && setState((s) => ({ loading: false, data: s.data, error })),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

// Runs one user action at a time and reports its outcome as a notice.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  // A success message fades out after a while, so it never lingers next to later states.
  useEffect(() => {
    if (notice?.kind !== 'ok') return undefined;
    const t = setTimeout(() => setNotice((n) => (n === notice ? null : n)), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  const run = useCallback(async (fn, pending) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    touch();
    if (pending) setNotice({ kind: 'info', text: pending });
    try {
      const result = await fn();
      if (mounted.current) setNotice(typeof result === 'string' ? { kind: 'ok', text: result } : null);
    } catch (error) {
      if (mounted.current) setNotice({ kind: 'error', text: errorText(error) });
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, notice, setNotice, run };
}

export function Notice({ kind = 'info', children, icon = kind === 'error' || kind === 'warn' }) {
  if (!children) return null;
  return (
    <p className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {icon ? <Alert size={16} /> : null}
      <span>{children}</span>
    </p>
  );
}
// The outcome of something the user just did. It scrolls into view when it appears, so
// an error under the fold is never missed.
export function ActionNotice({ notice }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.firstElementChild?.scrollIntoView?.({ block: 'nearest' });
  }, [notice]);
  return notice ? (
    <div ref={ref} className="notice-anchor">
      <Notice kind={notice.kind}>{notice.text}</Notice>
    </div>
  ) : null;
}

// A button that shows a spinner while its action runs, without changing its size or name.
export function ActionButton({ busy = false, icon = null, disabled, className = 'primary full', children, ...rest }) {
  return (
    <button type="button" className={className} disabled={busy || disabled} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="btn-spinner" aria-hidden="true" /> : icon}
      <span>{children}</span>
    </button>
  );
}

// Empty state: an icon, a short title and one helpful line.
export function Empty({ icon, title, children, level = 3, tone = '', compact = false }) {
  const H = `h${level}`;
  return (
    <div className={`empty${compact ? ' compact' : ''}`}>
      <span className={`empty-icon ${tone}`} aria-hidden="true">
        {icon}
      </span>
      <div>
        <H>{title}</H>
        {children}
      </div>
    </div>
  );
}

// The Quantum Seal mark in a round avatar. Sizes come from CSS classes (the extension's
// CSP has no 'unsafe-inline' for styles, so no style attributes anywhere).
export function Mark({ size = 'sm' }) {
  return (
    <span className={`mark mark-${size}`}>
      <img src="icons/mark.svg" alt="" />
    </span>
  );
}

export function Spinner({ label = 'Loading' }) {
  return <span className="spinner" role="progressbar" aria-label={label} />;
}
export function Loading({ label }) {
  return (
    <div className="loading">
      <Spinner label={label} />
    </div>
  );
}

export function QrCode({ text, cell = 4 }) {
  const { d, total } = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const size = q.getModuleCount();
    let path = '';
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (q.isDark(r, c)) path += `M${(c + 4) * cell} ${(r + 4) * cell}h${cell}v${cell}h-${cell}z`;
    return { d: path, total: (size + 8) * cell };
  }, [text, cell]);
  return (
    <svg className="qr" viewBox={`0 0 ${total} ${total}`} role="img" aria-label="QR code of this address">
      <rect width={total} height={total} fill="#fff" />
      <path d={d} fill="#05060c" />
    </svg>
  );
}

export function CopyButton({ text, label = 'Copy address', className = 'secondary' }) {
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setFailed(false);
          setCopied(true);
        } catch {
          // Clipboard unavailable; the address stays visible for manual copy.
          setFailed(true);
        }
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
      <span aria-live="polite">{copied ? 'Copied' : failed ? 'Copy failed: select the address' : label}</span>
    </button>
  );
}

// Bottom sheet on a native modal <dialog>: focus stays inside, Escape closes it.
// Content mounts only while open, so nothing behind a closed sheet stays in the DOM.
export function Sheet({ open, onClose, title, children }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      {open ? (
        <div className="sheet-body">
          <div className="sheet-grip" aria-hidden="true" />
          <div className="sheet-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
              <Close size={18} />
            </button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

// A labelled input. The label names only the input (hint and unit stay outside it).
// `aside` sits on the label's row, right-aligned (e.g. the available balance).
export function Field({ label, hint, unit, aside, children, className = '' }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const labelEl = (
    <label className="field-label" htmlFor={id}>
      {label}
    </label>
  );
  return (
    <div className={`field ${className}`}>
      {aside ? (
        <div className="field-top">
          {labelEl}
          <div className="field-aside">{aside}</div>
        </div>
      ) : (
        labelEl
      )}
      <span className="input-unit">
        {cloneElement(children, { id, 'aria-describedby': hint ? hintId : undefined })}
        {unit ? <b aria-hidden="true">{unit}</b> : null}
      </span>
      {hint ? (
        <small className="field-hint" id={hintId}>
          {hint}
        </small>
      ) : null}
    </div>
  );
}

// Persistent strip on every non-mainnet screen: addresses and SOL there are test-only.
// Screens that show an address to fund repeat the warning next to it.
export function TestNetworkBanner({ cluster, label }) {
  if (!cluster || cluster === 'mainnet-beta') return null;
  return (
    <aside className={`test-banner net-${cluster}`} aria-label="Test network">
      <Alert size={13} />
      <span>
        <strong>Test network · {label}</strong> · test SOL only, never real SOL
      </span>
    </aside>
  );
}

// Under an address on a test network: real SOL sent there is lost.
export function TestAddressCaption({ cluster }) {
  if (!cluster || cluster === 'mainnet-beta') return null;
  return (
    <p className="address-caption">
      <Alert size={13} />
      <span>Test SOL only: real SOL sent here is lost.</span>
    </p>
  );
}

// A label and value. Addresses (mono) are shown in full under their label, never cut.
export function KeyValue({ label, children, mono = false, strong = false }) {
  return (
    <div className={`kv${mono ? ' stack' : ''}${strong ? ' total' : ''}`}>
      <span>{label}</span>
      {mono ? <code>{children}</code> : <b>{children}</b>}
    </div>
  );
}
