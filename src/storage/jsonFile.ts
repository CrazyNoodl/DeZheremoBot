import fs from 'node:fs';
import path from 'node:path';
import * as Sentry from '@sentry/node';

// A missing file is the normal first-run state, not a failure — only log if the file exists but
// couldn't be read/parsed, since that's the case that used to silently "forget" everything.
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[storage] failed to read ${file}, falling back to default:`, err);
      Sentry.captureException(err);
    }
    return fallback;
  }
}

// Writes to a temp file in the same directory then renames over the target — rename is atomic on
// the same filesystem, so a crash mid-write can never leave a half-written, unparseable file behind.
export function writeJsonFileAtomic(file: string, data: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpFile, JSON.stringify(data));
  fs.renameSync(tmpFile, file);
}
