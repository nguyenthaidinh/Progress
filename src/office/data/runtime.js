// Shared source selection without importing scene/UI modules. Panels can read before the live stream starts.
import { createOfficeClient } from './client.js';
import { createLocalHttpSource } from './local-http.js';
import { OFFICE_SOURCE, activateEncryptedSource, deactivateEncryptedSource } from '../core/source-mode.js';
import { OfficeApiError } from '../../shared/contracts/api.js';

export const officeClient = createOfficeClient();
let localSource, encryptedSource;
export function selectEncryptedSource(adapter) {
  if (adapter.source !== 'encrypted-relay') throw new OfficeApiError('invalid');
  activateEncryptedSource(); encryptedSource = adapter; officeClient.selectSource(adapter);
}
export function markEncryptedRendererReady() { encryptedSource?.markRendererReady(); }
export function forgetEncryptedSource() {
  officeClient.close(); encryptedSource?.dispose(); encryptedSource = null; deactivateEncryptedSource();
}
export function getOfficeClient() {
  if (!officeClient.context) {
    if (OFFICE_SOURCE === 'encrypted-relay' && encryptedSource) { officeClient.selectSource(encryptedSource); return officeClient; }
    if (OFFICE_SOURCE !== 'local-http') throw new OfficeApiError('unavailable');
    localSource ||= createLocalHttpSource({ token: new URLSearchParams(location.search).get('k') || '',
      polling: /\.trycloudflare\.com$/.test(location.hostname) });
    officeClient.selectSource(localSource);
  }
  return officeClient;
}
