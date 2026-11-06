// IndexedDB structured-clones non-extractable CryptoKeys; no private JWK, transcript or prompt is stored.
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('lioops-trusted-pc', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pair');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('storage'));
  });
}
async function transaction(write, value) {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('pair', write ? 'readwrite' : 'readonly'), store = tx.objectStore('pair');
    const request = write ? value === null ? store.delete('active') : store.put(value, 'active') : store.get('active');
    tx.oncomplete = () => resolve(request.result || null); tx.onerror = tx.onabort = () => reject(new Error('storage'));
  }); } finally { db.close(); }
}
export const loadBrowserPair = () => transaction(false);
let writes = Promise.resolve();
export function saveBrowserPair(value) {
  // A pending pairing save must finish before a later Forget deletes it.
  const snapshot = value === null ? null : structuredClone(value), result = writes.then(() => transaction(true, snapshot));
  writes = result.catch(() => {}); return result;
}
