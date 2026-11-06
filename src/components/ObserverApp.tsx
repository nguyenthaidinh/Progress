'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Image from 'next/image';
import en from '@/i18n/locales/en/observer.js';
import vi from '@/i18n/locales/vi/observer.js';
import { contextBudget } from '@/shared/token-budget.js';
import { OBSERVATION_LIMITS, logFileAllowed } from '@/shared/observation.js';

type Message = { role: string; text: string; at: number | null };
type Session = { id: string; provider: string; name: string; project: string; model: string; updatedAt: number | null; status: string; partial: boolean; invalidLines: number;
  inputTokens: number | null; outputTokens: number | null; contextUsed: number | null; contextMax: number | null; messages: Message[]; events: { type: string; label: string; at: number | null }[] };
type Snapshot = { version: number; source: string; sampledAt: number; sessions: Session[] };
type LogFile = { file: File; key: string; handle?: { getFile(): Promise<File> } };
type Directory = { kind: 'directory'; name: string; values(): AsyncIterable<Directory | { kind: 'file'; name: string; getFile(): Promise<File> }>; queryPermission?(options: { mode: 'read' }): Promise<PermissionState> };
type PickerWindow = Window & { showDirectoryPicker?: (options: { mode: 'read' }) => Promise<Directory> };
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';
const subscribeCapabilities = () => () => {};
const supportsPicker = () => typeof (window as PickerWindow).showDirectoryPicker === 'function';
const secureContext = () => window.isSecureContext;

export default function ObserverApp({ language }: { language: string }) {
  const copy = language === 'vi' ? vi : en, locale = language === 'vi' ? 'vi-VN' : 'en-US';
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [selected, setSelected] = useState(''), [query, setQuery] = useState('');
  const [mode, setMode] = useState<'folder' | 'files' | ''>(''), [source, setSource] = useState(''), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState('');
  const [limited, setLimited] = useState(false), [issues, setIssues] = useState(false), [office, setOffice] = useState(false);
  const canPick = useSyncExternalStore(subscribeCapabilities, supportsPicker, () => false), secure = useSyncExternalStore(subscribeCapabilities, secureContext, () => true);
  const worker = useRef<Worker | null>(null), generation = useRef(0), working = useRef(false), directory = useRef<Directory | null>(null), sourceFiles = useRef<LogFile[]>([]);
  const lastScan = useRef(0);
  const input = useRef<HTMLInputElement>(null), frame = useRef<HTMLIFrameElement>(null), latest = useRef<Snapshot | null>(null), poll = useRef<() => void>(() => {});
  const invalidate = useCallback(() => { generation.current++; }, []);
  const publicWeb = process.env.NEXT_PUBLIC_OFFICE_WEB === '1';
  const number = (n: number | null) => n === null ? '—' : n.toLocaleString(locale);
  const date = (at: number | null) => at ? new Date(at).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '—';
  function publish(value: Snapshot | null) { frame.current?.contentWindow?.postMessage({ kind: 'lioops-observation', version: 1, snapshot: value }, location.origin); }
  useEffect(() => { latest.current = snapshot; publish(snapshot); }, [snapshot]);
  useEffect(() => {
    const w = new Worker(new URL('../workers/observation.worker.js', import.meta.url), { type: 'module' }); worker.current = w;
    w.onmessage = ({ data }) => {
      if (data?.id !== generation.current || !['snapshot', 'unchanged'].includes(data.kind)) return;
      if (data.kind === 'unchanged') { working.current = false; setBusy(false); return; }
      working.current = false; setBusy(false); setSnapshot(data.snapshot); setIssues(!!data.failed || data.snapshot.sessions.some((s: Session) => s.invalidLines));
      setFeedback(data.snapshot.sessions.length ? '' : copy.noData);
      setSelected(old => data.snapshot.sessions.some((s: Session) => s.id === old) ? old : data.snapshot.sessions[0]?.id || '');
    };
    w.onerror = () => { working.current = false; setBusy(false); setFeedback(copy.failed); };
    const message = (event: MessageEvent) => { if (event.origin === location.origin && event.source === frame.current?.contentWindow && event.data?.kind === 'lioops-observer-ready') publish(latest.current); };
    window.addEventListener('message', message);
    const timer = setInterval(() => { if (!document.hidden) poll.current(); }, 2500);
    return () => { invalidate(); w.terminate(); worker.current = null; clearInterval(timer); window.removeEventListener('message', message); };
  }, [copy, invalidate]);
  function reset() {
    generation.current++; directory.current = null; sourceFiles.current = []; working.current = false;
    worker.current?.postMessage({ kind: 'clear' });
    setSnapshot(null); setSelected(''); setMode(''); setSource(''); setFeedback(''); setLimited(false); setIssues(false); setBusy(false); setOffice(false);
    if (input.current) input.current.value = '';
  }
  async function collect(handle: Directory, id: number) {
    const found: LogFile[] = []; let entries = 0, cut = false;
    async function walk(dir: Directory, prefix = '', depth = 0) {
      for await (const entry of dir.values()) {
        if (id !== generation.current) throw new DOMException('Cancelled', 'AbortError');
        if (++entries > OBSERVATION_LIMITS.entries) { cut = true; return; }
        const key = `${prefix}/${entry.name}`;
        if (entry.kind === 'file' && logFileAllowed(entry.name)) { try { found.push({ file: await entry.getFile(), key, handle: entry }); } catch (error) { if ((error as Error).name === 'NotAllowedError') throw error; cut = true; } }
        else if (entry.kind === 'directory' && !['node_modules', '.git', 'credentials', 'auth'].includes(entry.name)) { if (depth < 8) await walk(entry, key, depth + 1); else cut = true; }
        if (entries > OBSERVATION_LIMITS.entries) return;
      }
    }
    await walk(handle); found.sort((a, b) => b.file.lastModified - a.file.lastModified);
    return { files: found.slice(0, OBSERVATION_LIMITS.files), limited: cut || found.length > OBSERVATION_LIMITS.files };
  }
  async function scan(handle: Directory | null = directory.current, files = sourceFiles.current, first = false, requestedId?: number) {
    if (working.current || !worker.current) return;
    const id = requestedId ?? ++generation.current;
    working.current = true; if (first) { setBusy(true); setFeedback(handle ? copy.scanning : copy.parsing); }
    try {
      if (handle?.queryPermission && await handle.queryPermission({ mode: 'read' }) === 'denied') throw new DOMException('Permission removed', 'NotAllowedError');
      if (handle && (first || Date.now() - lastScan.current > 15000)) {
        const result = await collect(handle, id); files = result.files; if (id !== generation.current) return; lastScan.current = Date.now(); setLimited(result.limited);
      } else if (handle) {
        const refreshed: LogFile[] = []; for (const entry of files) if (entry.handle) { try { refreshed.push({ ...entry, file: await entry.handle.getFile() }); } catch (error) { if ((error as Error).name === 'NotAllowedError') throw error; } }
        files = refreshed;
      }
      if (id !== generation.current) return;
      sourceFiles.current = files; worker.current.postMessage({ kind: 'read', id, reset: first, files: files.map(({ file, key }) => ({ file, key })), sampledAt: Date.now() });
    } catch (error) {
      if (id !== generation.current) return;
      working.current = false; setBusy(false);
      if ((error as Error).name === 'NotAllowedError') { reset(); setFeedback(copy.denied); }
      else if ((error as Error).name !== 'AbortError') setFeedback(copy.failed);
    }
  }
  useEffect(() => { poll.current = () => { if (directory.current && !working.current) void scan(); }; });
  async function pickFolder() {
    const picker = (window as PickerWindow).showDirectoryPicker; if (!picker || working.current) return;
    const id = ++generation.current;
    working.current = true; setBusy(true);
    try {
      const handle = await picker.call(window, { mode: 'read' }); if (id !== generation.current) return;
      directory.current = handle; setMode('folder'); setSource(handle.name); setIssues(false); working.current = false; await scan(handle, [], true, id);
    } catch (error) { if (id === generation.current) { working.current = false; setBusy(false); setFeedback((error as Error).name === 'AbortError' ? copy.cancelled : copy.failed); } }
  }
  function importFiles(files: File[]) {
    if (working.current) return; const id = ++generation.current, accepted = files.filter(f => logFileAllowed(f.name)).sort((a, b) => b.lastModified - a.lastModified);
    directory.current = null; setMode('files'); setSource(`${accepted.length} .jsonl`); setLimited(accepted.length > OBSERVATION_LIMITS.files);
    void scan(null, accepted.slice(0, OBSERVATION_LIMITS.files).map((file, index) => ({ file, key: `${index}/${file.name}` })), true, id);
  }
  const visible = snapshot?.sessions.filter(s => `${s.name} ${s.project} ${s.provider} ${s.model}`.toLowerCase().includes(query.toLowerCase())) || [];
  const session = snapshot?.sessions.find(s => s.id === selected), budget = session ? contextBudget({ ctx: session.contextUsed, ctxMax: session.contextMax }) : null;
  return <main className="ob-app">
    <header className="ob-header"><a href={`${BASE}/`} aria-label="LioOps"><Image src={`${BASE}/assets/branding/logo-wordmark-dark.svg`} alt="LioOps" width={160} height={46} unoptimized /></a><div className="ob-badges"><span>{copy.free}</span><span>{copy.readOnly}</span></div><a className="ob-back" href={publicWeb ? `${BASE}/office/?demo` : `${BASE}/`}>{publicWeb ? copy.demo : copy.back} ↗</a></header>
    <section className="ob-intro"><span className="ob-eyebrow">CODEX · CLAUDE</span><h1>{copy.title}</h1><p>{copy.subtitle}</p><div className="ob-private">◈ {copy.privacy}</div></section>
    <section className="ob-source" aria-label={copy.source}>
      <div className="ob-source-actions"><button className="ob-primary" disabled={!canPick || !secure || busy} onClick={() => void pickFolder()}>{mode ? copy.change : copy.folder}</button><button disabled={busy} onClick={() => input.current?.click()}>{copy.files}</button>
        {mode && <><button disabled={busy} onClick={() => void scan(directory.current, sourceFiles.current, true)}>{copy.refresh}</button><button className="ob-disconnect" onClick={reset}>{copy.clear}</button></>}
        <input ref={input} className="ob-file-input" type="file" accept=".jsonl" multiple aria-label={copy.files} onChange={e => { importFiles([...e.target.files || []]); e.target.value = ''; }} /></div>
      <p>{copy.help}</p>{!canPick && <p className="ob-notice">{secure ? copy.unsupported : copy.secure}</p>}
      {source && <small>{source} · {mode === 'folder' ? copy.auto : copy.snapshot}</small>}
      <div role="status" aria-live="polite" className="ob-feedback">{feedback}{busy && <span className="ob-loading" />}</div>
      {limited && <p className="ob-notice">{copy.limited}</p>}{issues && <p className="ob-notice">{copy.issues}</p>}
    </section>
    {!snapshot?.sessions.length ? <section className="ob-empty"><span>✧</span><h2>{copy.empty}</h2><p>{copy.emptyHint}</p></section> : <>
      <div className="ob-view"><b>{snapshot.sessions.length} {copy.sessions.toLowerCase()}</b><span>{copy.countHint}</span><button aria-pressed={office} onClick={() => setOffice(!office)}>{office ? copy.list : copy.office}</button></div>
      {office && <section className="ob-office"><p>{copy.officeNote}</p><iframe ref={frame} title={copy.officeTitle} src={`${BASE}/office/?observe=1&lang=${language}&layout=cozy`} /></section>}
      <section className="ob-content"><aside className="ob-sidebar"><input className="ob-search" aria-label={copy.search} placeholder={copy.search} value={query} onChange={e => setQuery(e.target.value)} /><div className="ob-session-list">{visible.map(s => <button className="ob-session" key={s.id} aria-current={s.id === selected} onClick={() => setSelected(s.id)}><small className={`ob-provider is-${s.provider}`}>{s.provider === 'codex' ? 'Codex' : 'Claude'}</small><b>{s.name}</b><span>{s.model || '—'}</span><time>{date(s.updatedAt)}</time></button>)}{!visible.length && <p>{copy.noMatches}</p>}</div></aside>
        {session && <article className="ob-detail"><div className="ob-detail-head"><div><h2>{session.name}</h2><p>{session.model || session.provider}</p></div><span className="ob-state">{session.status === 'work' ? copy.working : session.status === 'rest' ? copy.resting : copy.old}</span></div>
          <div className="ob-metrics"><div><span>{copy.context}</span><strong>{budget ? `${budget.leftPct}%` : '—'}</strong>{budget && <small>{number(session.contextUsed)} / {number(session.contextMax)}</small>}</div><div><span>{copy.input}</span><strong>{number(session.inputTokens)}</strong></div><div><span>{copy.output}</span><strong>{number(session.outputTokens)}</strong></div><div title={copy.quotaHint}><span>{copy.quota}</span><strong>—</strong><small>{copy.unknown}</small></div></div>
          <p className="ob-data-note">{copy.updated}: {date(session.updatedAt)} · {copy.estimate}</p>{session.partial && <p className="ob-notice">{copy.partial}</p>}<p className="ob-data-note">{copy.dataScope}</p>
          <details className="ob-events"><summary>{copy.activity} <small>{session.events.length}</small></summary>{session.events.length ? <ol>{session.events.map((e, i) => <li key={i}><code>{e.label}</code></li>)}</ol> : <p>{copy.noActivity}</p>}</details>
          <h3>{copy.messages}</h3><div className="ob-messages">{session.messages.map((m, i) => <article className={`ob-message is-${m.role}`} key={i}><header><b>{m.role === 'user' ? copy.user : copy.assistant}</b><time>{date(m.at)}</time></header><pre>{m.text}</pre></article>)}{!session.messages.length && <p>{copy.noMessages}</p>}</div>
        </article>}
      </section>
    </>}
    <footer className="ob-footer"><b>{copy.connector}</b><p>{copy.connectorHint}</p></footer>
  </main>;
}
