// Context capacity belongs to one conversation; account limits belong to quota windows.
export function contextBudget(usage) {
  if (!Number.isFinite(usage?.ctx) || usage.ctx < 0 || !Number.isFinite(usage.ctxMax) || usage.ctxMax <= 0) return null;
  const usedPct = Math.min(100, Math.round(usage.ctx / usage.ctxMax * 100));
  return { usedPct, leftPct: 100 - usedPct, used: usage.ctx, max: usage.ctxMax, left: Math.max(0, usage.ctxMax - usage.ctx) };
}
export function quotaLeft(window) {
  return Number.isFinite(window?.pct) ? Math.round(100 - Math.max(0, Math.min(100, window.pct))) : null;
}
