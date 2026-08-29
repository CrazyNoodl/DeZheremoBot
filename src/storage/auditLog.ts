import { db } from './history.js';

export type AdminAction =
  | 'pause'
  | 'resume'
  | 'draw'
  | 'reopen'
  | 'clearweek'
  | 'block'
  | 'unblock'
  | 'reset_schedule'
  | 'remind'
  | 'edit_reminder'
  | 'edit_deadline'
  | 'rating_toggle'
  | 'edit_rating'
  | 'send_rating_survey'
  | 'override_rating_place'
  | 'reset_rating_place'
  | 'edit_timeslot_days'
  | 'edit_timeslot_times'
  | 'toggle_timeslot_poll';

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    actor_user_id INTEGER NOT NULL,
    actor_name TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
`);

const logStmt = db.prepare(`
  INSERT INTO admin_actions (chat_id, actor_user_id, actor_name, action, detail, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export function logAdminAction(params: {
  chatId: number;
  actorUserId: number;
  actorName: string | undefined;
  action: AdminAction;
  detail?: string;
}): void {
  logStmt.run(params.chatId, params.actorUserId, params.actorName ?? null, params.action, params.detail ?? null, Date.now());
}

export interface AdminActionRecord {
  id: number;
  chatId: number;
  actorUserId: number;
  actorName: string | null;
  action: AdminAction;
  detail: string | null;
  createdAt: number;
}

const listStmt = db.prepare(`
  SELECT id, chat_id AS chatId, actor_user_id AS actorUserId, actor_name AS actorName, action, detail, created_at AS createdAt
  FROM admin_actions WHERE chat_id = ? ORDER BY id ASC
`);

// Read side exists only so tests can assert what got written — no filtering/pagination API,
// since a real viewer is a separate, later step.
export function listAdminActions(chatId: number): AdminActionRecord[] {
  return listStmt.all(chatId) as unknown as AdminActionRecord[];
}
