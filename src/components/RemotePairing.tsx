'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { initRemoteBrowser, subscribeRemote, remoteState, remoteServerState, requestRemotePair, retryRemote, forgetRemote } from '@/office/data/remote-browser.js';
import en from '@/i18n/locales/en/remote.js';
import vi from '@/i18n/locales/vi/remote.js';
import ObservationDetails from './ObservationDetails';
export default function RemotePairing({ language, compact = false, onOpen }: { language: string; compact?: boolean; onOpen?: () => void }) {
  const state = useSyncExternalStore(subscribeRemote, remoteState, remoteServerState), copy = language === 'vi' ? vi : en;
  useEffect(() => { void initRemoteBrowser(); }, []);
  if (compact) return state.paired ? <aside className="remote-status"><span role="status">{copy[state.status as keyof typeof copy] || copy.offline}</span><button type="button" onClick={onOpen}>{copy.open}</button>{state.observation && <ObservationDetails summary={state.observation} language={language} />}</aside> : null;
  if (state.status === 'idle') return null;
  return <section className="cs-remote" aria-label={copy.title}>
    <h2>{copy.title}</h2><p>{copy.intro}</p>
    {state.invite && <p>{copy.relay}: <code>{state.invite.relay}</code></p>}
    <p role="status">{copy[state.status as keyof typeof copy] || copy.pending}</p>
    {state.status === 'invited' && <button type="button" className="cs-primary" onClick={() => void requestRemotePair()}>{copy.connect}</button>}
    {state.fingerprint && <><p>{copy.compare}</p><code className="cs-fingerprint">{state.fingerprint}</code></>}
    {state.paired && <div className="cs-remote-actions"><button type="button" onClick={retryRemote}>{copy.retry}</button><button type="button" onClick={() => void forgetRemote()}>{copy.forget}</button></div>}
    <small>{state.protocol === 2 ? copy.scopeD : copy.scope}</small>
  </section>;
}
