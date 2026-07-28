import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
// Override lets tests point this at ':memory:' instead of touching the real data/ directory —
// node:sqlite's in-memory databases are process-local, so parallel test files never collide even
// with the identical override value.
const DB_FILE = process.env.DEZHEREMO_STATE_DB ?? path.join(DATA_DIR, 'state.db');

if (DB_FILE !== ':memory:') {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Shared by store.ts and lockState.ts: both hold this week's live cycle state for a chat and are
// reset together (resetWeek), so one connection/file for both rather than one each.
export const db = new DatabaseSync(DB_FILE);
