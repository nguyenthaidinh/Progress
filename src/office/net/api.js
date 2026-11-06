import { getOfficeClient } from '../data/runtime.js';
import { t as tr } from '../../i18n/index.js';

function localized(error) {
  if (error?.name === 'OfficeApiError') error.message = tr(`api.errors.${error.code}`);
  return error;
}
export function officeContext() { return getOfficeClient().context; }
export function officeCan(name) { try { return getOfficeClient().can(name); } catch { return false; } }
export function officeResource(name, params) { try { return getOfficeClient().resourceUrl(name, params); } catch (error) { throw localized(error); } }
export async function officeRequest(name, params = {}, options = {}) {
  try {
    const response = await getOfficeClient().request(name, params, options);
    return Object.freeze({ ok: response.ok, status: response.status, json: async () => {
      try { return await response.json(); } catch (error) { throw localized(error); }
    } });
  } catch (error) { throw localized(error); }
}
export async function officeJson(name, params, options) { return (await officeRequest(name, params, options)).json(); }
