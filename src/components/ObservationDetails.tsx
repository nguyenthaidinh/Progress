'use client';
import type { RemoteSummary } from '@/office/data/observation-cache.js';
import en from '@/i18n/locales/en/remote.js';
import vi from '@/i18n/locales/vi/remote.js';
export default function ObservationDetails({ summary, language }: { summary: RemoteSummary; language: string }) {
  const copy = language === 'vi' ? vi : en, locale = language === 'vi' ? 'vi-VN' : 'en-US';
  const time = (at: number) => new Date(at).toLocaleString(locale);
  const memory = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString(locale, { maximumFractionDigits: 1 })} GB`;
  const oldMetrics = summary.metrics && (summary.sampledAt - summary.metrics.sampledAt > 15000 || summary.metrics.sampledAt > summary.sampledAt + 15000);
  return <details className="remote-overview" id="remote-observation" data-revision={summary.revision}><summary>{copy.overview}</summary>
    <div className="remote-overview-body">
      <small>{copy.readAt}: {time(summary.sampledAt)}</small>
      {summary.availability === 'unavailable' && <p role="status">{copy.logUnavailable}</p>}
      {!!summary.unknown && <p>{copy.unknownCount}: {summary.unknown}</p>}
      {summary.partial && <p>{copy.bounded}</p>}
      <section aria-label={copy.pcMetrics}><h3>{copy.pcMetrics}</h3>
        {!summary.permissions.systemMetrics ? <p>{copy.notAllowed}</p> : !summary.metrics ? <p>{copy.noData}</p> : oldMetrics ? <p>{copy.stale}</p> : <>
          <p data-metric="cpu">{copy.cpu}: {summary.metrics.cpuPct === null ? copy.noData : `${summary.metrics.cpuPct}%`}</p>
          <p data-metric="memory">{copy.memory}: {memory(summary.metrics.memory.used)} / {memory(summary.metrics.memory.total)}</p>
          <small>{copy.readAt}: {time(summary.metrics.sampledAt)}</small>
        </>}
      </section>
      <section aria-label={copy.quota}><h3>{copy.quota}</h3><small>{copy.quotaNote}</small>
        {!summary.permissions.accountQuota ? <p>{copy.notAllowed}</p> : !summary.quotas.length ? <p>{copy.noData}</p> : summary.quotas.map((quota, index) => <div className="remote-quota" key={`${quota.provider}:${quota.session}:${index}`}>
          <b>{quota.session} · {quota.provider === 'codex' ? 'Codex' : 'Claude'}</b><small>{copy.readAt}: {time(quota.at)}</small>
          {quota.windows.map(window => {
            const stale = summary.sampledAt - quota.at > 300000 || quota.at > summary.sampledAt + 15000 || window.resetsAt !== null && window.resetsAt <= summary.sampledAt;
            return <p key={window.key} data-quota-state={stale ? 'stale' : 'fresh'}>{window.minutes ? `${window.minutes} ${copy.windowMinutes} · ` : ''}
              {stale ? copy.stale : `${Math.round(100 - window.usedPct)}% ${copy.remaining}`}{window.resetsAt !== null && <small>{copy.resets}: {time(window.resetsAt)}</small>}</p>;
          })}
        </div>)}
      </section>
    </div>
  </details>;
}
