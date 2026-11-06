'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Image from 'next/image';
import en from '@/i18n/locales/en/connection.js';
import vi from '@/i18n/locales/vi/connection.js';
import { resolveOfficeSource } from '@/shared/office-source.js';
import { officeRequest } from '@/office/net/api.js';
import RemotePairing from './RemotePairing';
import { subscribeRemote, remoteState, remoteServerState } from '@/office/data/remote-browser.js';
const subscribe = () => () => {};
const selectedSource = () => resolveOfficeSource({ search: location.search, defaultSource: process.env.NEXT_PUBLIC_OFFICE_SOURCE });
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';
const words = { en, vi };

export default function ConnectionSetup({ language, publicWeb, staticBuild }: { language: string; publicWeb: boolean; staticBuild: boolean }) {
  const copy = language === 'vi' ? words.vi : words.en;
  const source = useSyncExternalStore(subscribe, selectedSource, () => null);
  const remote = useSyncExternalStore(subscribeRemote, remoteState, remoteServerState);
  const initial = source === 'unpaired' && !remote.paired;
  const local = source === 'local-http' && !publicWeb && !staticBuild;
  const [requested, setRequested] = useState(false), [dismissed, setDismissed] = useState(false), [connection, setConnection] = useState('checking');
  const dialog = useRef<HTMLDivElement>(null);
  const open = requested || initial && !dismissed;
  const canClose = !initial || dismissed;
  function close() { setRequested(false); setDismissed(true); }
  useEffect(() => {
    const show = () => { setConnection('checking'); setRequested(true); };
    const click = (event: MouseEvent) => { if ((event.target as Element)?.closest?.('#st-connection-setup')) show(); };
    document.addEventListener('click', click); document.addEventListener('lioops:setup-open', show);
    return () => { document.removeEventListener('click', click); document.removeEventListener('lioops:setup-open', show); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null; dialog.current?.focus();
    const controller = new AbortController();
    if (local) {
      officeRequest('tasks.metadata', {}, { signal: controller.signal }).then(async r => r.ok && (await r.json()).ok === true)
        .then(ok => setConnection(ok ? 'connected' : 'unavailable')).catch(error => { if (error.name !== 'AbortError') setConnection('unavailable'); });
    }
    return () => { controller.abort(); previous?.focus?.(); };
  }, [open, local]);
  const remoteAllowed = source === 'unpaired';
  return <>{remoteAllowed && <RemotePairing language={language} compact onOpen={() => setRequested(true)} />}{open && <div className="cs-backdrop"><div className="cs-dialog" role="dialog" aria-modal="true" aria-labelledby="cs-heading" tabIndex={-1} ref={dialog} onKeyDown={event => {
    if (event.key === 'Escape' && canClose) { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')], first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><Image src={`${BASE}/assets/branding/logo-wordmark-dark.svg`} alt="LioOps" width={150} height={43} unoptimized /><span>{copy.title}</span>{canClose && <button type="button" aria-label={copy.close} onClick={close}>×</button>}</header>
    <h1 id="cs-heading">{copy.heading}</h1><p>{copy.intro}</p>
    <ol className="cs-steps">{copy.steps.map((step, i) => <li key={step}><i>{i + 1}</i><span>{step}</span></li>)}</ol>
    <section className="cs-privacy"><b>◈ {copy.local}</b><p>{copy.privacy}</p><small>{copy.provider}</small></section>
    {remoteAllowed && <RemotePairing language={language} />}
    {local ? <div className="cs-local"><p role="status">{copy[connection as 'checking' | 'connected' | 'unavailable']}</p><button type="button" className="cs-primary" onClick={close}>{copy.resume}</button></div> : <div className="cs-install"><button type="button" className="cs-primary" disabled>{copy.download}</button><p>{copy.pending}</p><a className="cs-existing" href={`http://127.0.0.1:4310/?lang=${language === 'vi' ? 'vi' : 'en'}`}>{copy.open} ↗</a><a className="cs-sample" href={`${BASE}/?demo`}>{copy.sample}</a></div>}
    <p className="cs-note">{copy.note}</p>
  </div></div>}</>;
}
