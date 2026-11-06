import { resolveOfficeSource } from '../../shared/office-source.js';

export let OFFICE_SOURCE = resolveOfficeSource({
  search: typeof location === 'undefined' ? '' : location.search,
  defaultSource: process.env.NEXT_PUBLIC_OFFICE_SOURCE,
});
export const BROWSER_OBSERVER = OFFICE_SOURCE === 'browser-log';
// Only the consent/pairing runtime can activate this source; URL queries never select PC access.
export function activateEncryptedSource() {
  if (!['unpaired', 'encrypted-relay'].includes(OFFICE_SOURCE)) throw new Error('Source already selected');
  OFFICE_SOURCE = 'encrypted-relay';
}
export function deactivateEncryptedSource() { if (OFFICE_SOURCE === 'encrypted-relay') OFFICE_SOURCE = 'unpaired'; }
