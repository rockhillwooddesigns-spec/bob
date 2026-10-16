import type { Artwork, ArtworkSummary } from './types';

const DATABASE = 'contour-temporary-workspaces-v1';
const STORE = 'files';
let connection: Promise<IDBDatabase> | undefined;
type StoredFile = { key: string; createdAt: number; blob: Blob; summary?: ArtworkSummary };

function database() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('createdAt', 'createdAt');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Browser storage is blocked. Close older Contour tabs and retry.'));
  });
  return connection;
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = operation(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Browser storage is unavailable. Free some disk space and retry.'));
  });
}

const key = (workspace: string, kind: string, id: string) => `${workspace}:${kind}:${id}`;

export async function storeArtwork(workspace: string, art: Artwork): Promise<{ summary: ArtworkSummary; bytes: number }> {
  const blob = await (await fetch(art.image)).blob();
  const summary: ArtworkSummary = { id: art.id, name: art.name, image: art.thumbnail || art.image, width: art.width, height: art.height, demo: art.demo };
  await transaction('readwrite', store => store.put({ key: key(workspace, 'art', art.id), createdAt: Date.now(), blob, summary } satisfies StoredFile));
  return { summary, bytes: blob.size };
}

export async function artworkBlob(workspace: string, id: string): Promise<Blob> {
  const record = await transaction('readonly', store => store.get(key(workspace, 'art', id))) as StoredFile | undefined;
  if (!record) throw new Error('This artwork is no longer in browser storage. Re-import the image.');
  return record.blob;
}

export async function loadArtwork(workspace: string, summary: ArtworkSummary): Promise<Artwork> {
  const bitmap = await createImageBitmap(await artworkBlob(workspace, summary.id));
  try {
    const canvas = new OffscreenCanvas(summary.width, summary.height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    return { ...summary, pixels: context.getImageData(0, 0, summary.width, summary.height).data };
  } finally { bitmap.close(); }
}

export async function deleteArtwork(workspace: string, id: string) {
  await transaction('readwrite', store => store.delete(key(workspace, 'art', id)));
}

export async function saveDownload(workspace: string, id: string, blob: Blob) {
  await transaction('readwrite', store => store.put({ key: key(workspace, 'export', id), createdAt: Date.now(), blob } satisfies StoredFile));
}

export async function downloadBlob(workspace: string, id: string): Promise<Blob> {
  const record = await transaction('readonly', store => store.get(key(workspace, 'export', id))) as StoredFile | undefined;
  if (!record) throw new Error('This download has expired. Export your batch again.');
  return record.blob;
}

async function deleteRange(index: string | null, range: IDBKeyRange) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const source = index ? tx.objectStore(STORE).index(index) : tx.objectStore(STORE);
    const request = source.openCursor(range);
    request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function clearDownloads(workspace: string) {
  await deleteRange(null, IDBKeyRange.bound(`${workspace}:export:`, `${workspace}:export:\uffff`));
}

export async function clearArtwork(workspace: string) {
  await deleteRange(null, IDBKeyRange.bound(`${workspace}:art:`, `${workspace}:art:\uffff`));
}

export async function cleanExpiredWorkspaces() {
  await deleteRange('createdAt', IDBKeyRange.upperBound(Date.now() - 24 * 60 * 60 * 1000));
}

export async function ensureStorageAvailable(bytes: number) {
  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < bytes + 64 * 1024 * 1024) {
    throw new Error('Browser storage is nearly full. Export this batch and free disk space before adding more artwork.');
  }
}
