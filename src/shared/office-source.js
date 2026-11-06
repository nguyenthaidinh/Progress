// Build format and data source are independent. A public export never implicitly connects to the hosting server.
export function resolveOfficeSource({ search = '', defaultSource = 'unpaired' } = {}) {
  const query = new URLSearchParams(search);
  if (query.has('observe')) return 'browser-log';
  if (query.has('demo')) return 'demo';
  return ['local-http', 'demo'].includes(defaultSource) ? defaultSource : 'unpaired';
}
