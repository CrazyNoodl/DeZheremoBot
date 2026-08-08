import fs from 'node:fs';
import path from 'node:path';
import { snapshotDatabaseFile } from '../storage/backupSnapshot.js';
import { getStateDbPath } from '../storage/db.js';
import { getHistoryDbPath } from '../storage/history.js';

// Run standalone (`node dist/scripts/backup.js`) against the live container by the nightly
// GitHub Actions backup workflow (see .github/workflows/backup.yml), which then pulls the two
// files this writes off the machine via `fly ssh sftp get` — never imported by the bot itself,
// so unlike storage/db.ts's own tests this needs no env-var override: DEZHEREMO_STATE_DB/
// DEZHEREMO_HISTORY_DB are whatever the running deploy actually uses.
const backupDir = path.join(path.dirname(getStateDbPath()), 'backup');
fs.mkdirSync(backupDir, { recursive: true });

for (const [fileName, sourcePath] of [
  ['state.db', getStateDbPath()],
  ['history.db', getHistoryDbPath()],
] as const) {
  const destPath = path.join(backupDir, fileName);
  snapshotDatabaseFile(sourcePath, destPath);
  console.log(`[backup] wrote ${destPath}`);
}
