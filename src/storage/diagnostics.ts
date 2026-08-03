import fs from 'node:fs';
import { getStateDbPath } from './db.js';
import { getHistoryDbPath } from './history.js';

export interface StorageDiagnostics {
  stateDbBytes: number | null;
  historyDbBytes: number | null;
}

// statSync throws for a missing file or the ':memory:' test override — null (not a thrown error)
// lets the /admin diagnostics screen render "н/д" for that one field instead of failing the whole
// screen. Exported (takes a path, not a module-level const) so tests can exercise both branches
// directly against a real temp file, the same testability reasoning storage/jsonFile.ts's
// path-argument functions already follow.
export function getFileSizeBytes(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

export function getStorageDiagnostics(): StorageDiagnostics {
  return {
    stateDbBytes: getFileSizeBytes(getStateDbPath()),
    historyDbBytes: getFileSizeBytes(getHistoryDbPath()),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
