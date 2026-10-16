export const MAX_BATCH_DESIGNS = 500;
export const MAX_WORKSPACE_BYTES = 1024 * 1024 * 1024;
export const ZIP_DESIGNS_PER_PART = 50;
export const ZIP_BYTES_PER_PART = 32 * 1024 * 1024;
export const PDF_PIXELS_PER_PART = 16_000_000;
export const PDF_DESIGNS_PER_PART = 25;
export const ARTWORK_PAGE_SIZE = 25;

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
