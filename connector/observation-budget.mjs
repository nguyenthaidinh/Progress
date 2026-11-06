// Leave room for both nested JOSE/base64 layers. Keep the newest detail; never silently exceed the relay budget.
export const OBSERVATION_BYTES = 125000;
export function boundObservation(value) {
  const result = structuredClone(value), bytes = () => Buffer.byteLength(JSON.stringify(result));
  const detail = result.details, selected = result.sessions.find(session => session.id === detail?.id);
  while (bytes() > OBSERVATION_BYTES && detail?.messages.length > 1) { detail.messages.shift(); if (selected) selected.partial = true; result.discovery.partial = true; }
  while (bytes() > OBSERVATION_BYTES && detail?.events.length) { detail.events.shift(); if (selected) selected.partial = true; result.discovery.partial = true; }
  if (bytes() > OBSERVATION_BYTES) {
    for (const session of result.sessions) session.events = [];
    result.discovery.partial = true;
  }
  while (bytes() > OBSERVATION_BYTES && result.sessions.length > 1) {
    const index = result.sessions.findLastIndex(session => session.id !== selected?.id);
    if (index < 0) break;
    const [removed] = result.sessions.splice(index, 1); result.quotas = result.quotas.filter(quota => quota.sessionId !== removed.id);
    result.discovery.limited = true;
  }
  if (result.discovery.partial || result.discovery.limited) result.availability = 'partial';
  if (bytes() > OBSERVATION_BYTES) throw new Error('Observation exceeds bounded schema');
  return result;
}
