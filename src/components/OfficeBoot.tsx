'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { resolveOfficeSource } from '@/shared/office-source.js';
import { initRemoteBrowser, subscribeRemote, remoteState, remoteServerState } from '@/office/data/remote-browser.js';

// Signs, screens and the whiteboard are painted onto canvases once, at start, and a canvas does not wait for web
// fonts: load the faces they use first (at most 1.5 s, then start anyway with whatever is there).
const FACES = ['400 16px "Be Vietnam Pro"', '600 16px "Be Vietnam Pro"', '700 16px "Be Vietnam Pro"', '800 16px "Be Vietnam Pro"', '400 16px "JetBrains Mono"'];
const fontsReady = () => Promise.race([
  Promise.all(FACES.map((f) => document.fonts.load(f, 'Office ờ'))).catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, 1500)),
]);

// Starts the 3D office once the page's markup is on screen. The office (src/office) is plain JavaScript that binds to
// the markup by id and runs for the life of the page, so it starts once and is never torn down.
export default function OfficeBoot() {
  const remote = useSyncExternalStore(subscribeRemote, remoteState, remoteServerState);
  useEffect(() => {
    const source = resolveOfficeSource({ search: location.search, defaultSource: process.env.NEXT_PUBLIC_OFFICE_SOURCE });
    if (source === 'unpaired') {
      void initRemoteBrowser();
      if (!['authenticated', 'connected'].includes(remote.status)) return;
    }
    void Promise.all([import('@/office/main'), fontsReady()]).then(([m]) => m.startOffice());
  }, [remote.status]);
  return null;
}
