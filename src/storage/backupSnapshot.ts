import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// A fresh read-only connection onto the source file — VACUUM INTO only ever reads from its
// source, so this never contends with the running bot process for its write lock, unlike a plain
// file copy which could grab a half-written file mid-transaction. Writes to destPath via a bound
// parameter rather than string-interpolating the path into the SQL text, and removes any stale
// file at destPath first: VACUUM INTO refuses to overwrite an existing file, and overwriting one
// in place would risk leaving a half-written file behind if the process died mid-VACUUM — the same
// "never leave a partial file where a good one used to be" reasoning storage/jsonFile.ts already
// follows for its own writes, just via SQLite's own single-statement copy instead of a manual
// temp-file-then-rename.
export function snapshotDatabaseFile(sourcePath: string, destPath: string): void {
  fs.rmSync(destPath, { force: true });

  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(destPath);
  } finally {
    db.close();
  }
}
