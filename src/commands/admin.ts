import { Markup, type Context } from 'telegraf';
import { buildDrawAnnouncement } from '../messaging/announcements.js';
import { placeLabel, placeLinkWithHint } from '../utils/htmlFormat.js';
import { handleAdminEntryCommand, isGroupAdmin, showGatedMenu } from './access.js';
import { formatKyivDateTime, getKyivNow } from '../utils/kyivTime.js';
import { getLastTickAt, sendRatingSurvey, SCHEDULER_STUCK_THRESHOLD_MS } from '../scheduler.js';
import {
  blockUserFromGroup,
  getAllSubmissions,
  isGroupPaused,
  isRepeatWinner,
  isSubmissionLocked,
  listBlockedUsersInGroup,
  pauseGroup,
  pickWeeklyWinner,
  recordDraw,
  reopenSubmissions,
  resetWeek,
  resumeGroup,
  unblockUserFromGroup,
} from '../services/submissionService.js';
import { getRatingSurveyContext, isRatingSurveyEnabled, setRatingSurveyEnabled } from '../services/ratingService.js';
import { listAdminActions, logAdminAction, type AdminAction, type AdminActionRecord } from '../storage/auditLog.js';
import { markFired } from '../storage/firedEvents.js';
import { formatBytes, getStorageDiagnostics } from '../storage/diagnostics.js';
import { getTopParticipants, getTopWinningPlaces } from '../storage/history.js';
import { getTopRaters } from '../storage/placeRatings.js';
import { clearRatingSelection, getRatingSelection, setRatingSelection } from '../storage/ratingSelectionState.js';
import { sendToChat } from '../messaging/telegramBroadcast.js';
import { createPanel, safeAnswerCbQuery } from './panel.js';

// Same 48h reasoning as MENU_MESSAGE_TTL_MS in menuMessage.ts / SCHEDULE_PANEL_TTL_MS in schedule.ts.
const ADMIN_PANEL_TTL_MS = 48 * 60 * 60 * 1000;

const panel = createPanel(ADMIN_PANEL_TTL_MS, 'admin');

function buildPanelText(paused: boolean, placeCount: number, declineCount: number, locked: boolean, blockedCount: number): string {
  return (
    (paused ? '⏸ Цикл призупинено — нагадування, закриття заявок і розіграш не виконуються\n\n' : '') +
    `🛠 Адмін-панель цієї групи\n\n` +
    `📝 Подано заявок цього тижня: ${placeCount}${declineCount > 0 ? ` (+ ${declineCount} не йдуть)` : ''}` +
    `${locked ? ' (прийом закрито)' : ''}` +
    (blockedCount > 0 ? `\n🚫 Заблоковано користувачів: ${blockedCount}` : '')
  );
}

// The main hub is deliberately just 4 category entries, not individual actions — /admin grew too
// many buttons on one screen as features accumulated (pause/resume, draw, reopen, clearweek,
// blocklist, rating, stats all lived here at once). Each category now gets its own sub-panel; see
// renderCyclePanel/renderBlocklistPanel/renderRatingHub/renderExperimentalMenu below.
function buildHubKeyboard(chatId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Цикл тижня', `admin:cycle:${chatId}`)],
    [Markup.button.callback('🚫 Учасники', `admin:blocklist:${chatId}`)],
    [Markup.button.callback('⭐ Опитування', `admin:rating:${chatId}`)],
    [Markup.button.callback('🧪 Експериментальні функції', `admin:experimental:${chatId}`)],
  ]);
}

function buildCycleText(paused: boolean, placeCount: number, declineCount: number, locked: boolean): string {
  return (
    (paused ? '⏸ Цикл призупинено — нагадування, закриття заявок і розіграш не виконуються\n\n' : '') +
    `🔄 Цикл тижня цієї групи\n\n` +
    `📝 Подано заявок цього тижня: ${placeCount}${declineCount > 0 ? ` (+ ${declineCount} не йдуть)` : ''}` +
    `${locked ? ' (прийом закрито)' : ''}`
  );
}

function buildCycleKeyboard(chatId: number) {
  const paused = isGroupPaused(chatId);
  const locked = isSubmissionLocked(chatId);
  const rows = [
    [
      Markup.button.callback(
        paused ? '▶️ Відновити цикл' : '⏸ Призупинити цикл',
        `admin:${paused ? 'resume' : 'pause'}:${chatId}`,
      ),
    ],
  ];
  if (locked) {
    rows.push([Markup.button.callback('🔓 Відкрити прийом заявок', `admin:reopen:${chatId}`)]);
  }
  rows.push([Markup.button.callback('🔀 Провести жеребкування зараз', `admin:draw:${chatId}`)]);
  rows.push([Markup.button.callback('🧹 Скинути тиждень (без розіграшу)', `admin:clearweek:${chatId}`)]);
  rows.push([Markup.button.callback('‹ Назад', `admin:select:${chatId}`)]);
  return Markup.inlineKeyboard(rows);
}

async function renderCyclePanel(ctx: Context, userId: number, chatId: number): Promise<void> {
  const submissions = getAllSubmissions(chatId);
  const placeCount = submissions.filter((s) => s.status === 'submitted').length;
  const declineCount = submissions.filter((s) => s.status === 'declined').length;
  await panel.update(
    ctx,
    userId,
    buildCycleText(isGroupPaused(chatId), placeCount, declineCount, isSubmissionLocked(chatId)),
    buildCycleKeyboard(chatId),
  );
}

function buildExperimentalKeyboard(chatId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Статистика', `admin:stats:${chatId}`)],
    [Markup.button.callback('🩺 Діагностика планувальника', `admin:diagnostics:${chatId}`)],
    [Markup.button.callback('📜 Лог дій адмінів', `admin:auditlog:${chatId}:0`)],
    [Markup.button.callback('‹ Назад', `admin:select:${chatId}`)],
  ]);
}

// A holding area for features not yet polished enough to live on the main hub — currently just
// statistics (see "Admin statistics"), so a future rough feature has an obvious home instead of
// crowding the hub again.
async function renderExperimentalMenu(ctx: Context, userId: number, chatId: number): Promise<void> {
  await panel.update(
    ctx,
    userId,
    '🧪 Експериментальні функції\n\nСюди потрапляють нові можливості, поки їх не доведено до ладу.\n\nОбери, що подивитися:',
    buildExperimentalKeyboard(chatId),
  );
}

// Content is global (one scheduler tick loop and one pair of DB files for the whole bot), not
// scoped to whichever group's /admin this was opened from — see CLAUDE.md's "Admin statistics"
// sibling reasoning for why a read-only screen like this doesn't need per-chat data.
// SCHEDULER_STUCK_THRESHOLD_MS itself lives in scheduler.ts now, shared with its own active
// stuck-tick alert, so the passive indicator here and that alert can't drift into disagreeing
// about what "stuck" means.

function buildDiagnosticsText(): string {
  const lastTickAt = getLastTickAt();
  const tickLine =
    lastTickAt === null
      ? '⏳ ще не було жодного тіка'
      : `${Date.now() - lastTickAt > SCHEDULER_STUCK_THRESHOLD_MS ? '🔴' : '🟢'} ${Math.round((Date.now() - lastTickAt) / 1000)} сек тому (${formatKyivDateTime(lastTickAt)})`;

  const { stateDbBytes, historyDbBytes } = getStorageDiagnostics();
  const stateSize = stateDbBytes !== null ? formatBytes(stateDbBytes) : 'н/д';
  const historySize = historyDbBytes !== null ? formatBytes(historyDbBytes) : 'н/д';

  return (
    `🩺 Діагностика планувальника\n\n` +
    `Останній тік: ${tickLine}\n` +
    `Розмір БД: state.db — ${stateSize}, history.db — ${historySize}`
  );
}

function buildDiagnosticsKeyboard(chatId: number) {
  return Markup.inlineKeyboard([[Markup.button.callback('‹ Назад', `admin:experimental:${chatId}`)]]);
}

async function renderDiagnosticsPanel(ctx: Context, userId: number, chatId: number): Promise<void> {
  await panel.update(ctx, userId, buildDiagnosticsText(), buildDiagnosticsKeyboard(chatId));
}

// Ukrainian label for every AdminAction, keyed as a Record so a new action added to the union in
// storage/auditLog.ts is a compile error here until it gets a label too.
const ADMIN_ACTION_LABELS: Record<AdminAction, string> = {
  pause: 'Призупинив цикл',
  resume: 'Відновив цикл',
  draw: 'Провів розіграш',
  reopen: 'Відкрив прийом заявок',
  clearweek: 'Скинув тиждень',
  block: 'Заблокував',
  unblock: 'Розблокував',
  reset_schedule: 'Скинув розклад',
  remind: 'Надіслав нагадування',
  edit_reminder: 'Змінив розклад нагадувань',
  edit_deadline: 'Змінив дедлайн',
  rating_toggle: 'Перемкнув опитування',
  edit_rating: 'Змінив розклад опитування',
  send_rating_survey: 'Надіслав опитування',
};

const AUDIT_LOG_PAGE_SIZE = 10;

// actorName was captured at write-time as `ctx.from?.username ?? ctx.from?.first_name` (see
// logAdminAction call sites below) — there's no way to tell which one it was by the time it's read
// back, so it's rendered as-is rather than guessing an "@" prefix the way displayName does for a
// known-real username.
function auditActorLabel(record: AdminActionRecord): string {
  return record.actorName ?? `id${record.actorUserId}`;
}

function buildAuditLogRow(record: AdminActionRecord): string {
  const detailSuffix = record.detail ? ` (${record.detail})` : '';
  return `${formatKyivDateTime(record.createdAt)} — ${auditActorLabel(record)}: ${ADMIN_ACTION_LABELS[record.action]}${detailSuffix}`;
}

interface AuditLogPage {
  text: string;
  page: number;
  totalPages: number;
}

// listAdminActions returns everything for this chat, oldest-first, unpaginated (deliberately, per
// its own comment — a real viewer was always meant to be a separate, later step). Sorting/paging
// happen here on the already-fetched array rather than in storage/auditLog.ts, the same
// fetch-once-filter-in-the-command shape buildBlocklistKeyboard already uses.
function buildAuditLogPage(chatId: number, requestedPage: number): AuditLogPage {
  const records = listAdminActions(chatId).slice().reverse();
  if (records.length === 0) {
    return { text: '📜 Лог дій адмінів\n\nЩе немає жодної дії в журналі.', page: 0, totalPages: 0 };
  }
  const totalPages = Math.ceil(records.length / AUDIT_LOG_PAGE_SIZE);
  // Clamped rather than trusted as-is: a stale button from before the log somehow shrank (not
  // expected in practice, since this log is append-only, but cheap to guard) would otherwise
  // request an out-of-bounds slice.
  const page = Math.min(Math.max(requestedPage, 0), totalPages - 1);
  const start = page * AUDIT_LOG_PAGE_SIZE;
  const pageRecords = records.slice(start, start + AUDIT_LOG_PAGE_SIZE);
  const text = `📜 Лог дій адмінів (стор. ${page + 1}/${totalPages})\n\n${pageRecords.map(buildAuditLogRow).join('\n')}`;
  return { text, page, totalPages };
}

function buildAuditLogKeyboard(chatId: number, page: number, totalPages: number) {
  const navRow: ReturnType<typeof Markup.button.callback>[] = [];
  if (page > 0) navRow.push(Markup.button.callback('‹ Новіші', `admin:auditlog:${chatId}:${page - 1}`));
  if (page < totalPages - 1) navRow.push(Markup.button.callback('Старіші ›', `admin:auditlog:${chatId}:${page + 1}`));
  const rows = navRow.length > 0 ? [navRow] : [];
  rows.push([Markup.button.callback('‹ Назад', `admin:experimental:${chatId}`)]);
  return Markup.inlineKeyboard(rows);
}

async function renderAuditLogPanel(ctx: Context, userId: number, chatId: number, page: number): Promise<void> {
  const { text, page: clampedPage, totalPages } = buildAuditLogPage(chatId, page);
  await panel.update(ctx, userId, text, buildAuditLogKeyboard(chatId, clampedPage, totalPages));
}

function displayName(username: string | null | undefined, userId: number): string {
  return username ? `@${username}` : `id${userId}`;
}

function buildBlocklistText(chatId: number): string {
  const blocked = listBlockedUsersInGroup(chatId);
  return (
    `🚫 Блокування учасників цієї групи\n\n` +
    (blocked.length > 0
      ? `Заблоковані:\n${blocked.map((b) => `• ${displayName(b.username, b.userId)}`).join('\n')}`
      : 'Наразі нікого не заблоковано.') +
    `\n\nБлокувати можна серед тих, хто відповів цього тижня — натисни на ім'я нижче.`
  );
}

// Only this week's responders (place submitted or "не йду") can be offered for blocking here:
// there is no persistent directory of everyone who's ever used the bot, just this week's
// submissions table.
function buildBlocklistKeyboard(chatId: number) {
  const blocked = listBlockedUsersInGroup(chatId);
  const blockedIds = new Set(blocked.map((b) => b.userId));
  const rows = getAllSubmissions(chatId)
    .filter((s) => !blockedIds.has(s.userId))
    .map((s) => [
      Markup.button.callback(
        `🚫 ${displayName(s.username, s.userId)}${s.status === 'declined' ? ' (не йде)' : ''}`,
        `admin:block:${chatId}:${s.userId}`,
      ),
    ]);
  blocked.forEach((b) => {
    rows.push([
      Markup.button.callback(`✅ Розблокувати ${displayName(b.username, b.userId)}`, `admin:unblock:${chatId}:${b.userId}`),
    ]);
  });
  rows.push([Markup.button.callback('‹ Назад', `admin:select:${chatId}`)]);
  return Markup.inlineKeyboard(rows);
}

async function renderBlocklistPanel(ctx: Context, userId: number, chatId: number): Promise<void> {
  await panel.update(ctx, userId, buildBlocklistText(chatId), buildBlocklistKeyboard(chatId));
}

// The category's own hub — mirrors buildCycleKeyboard's pause/resume toggle, since
// enabling/disabling the survey is live-cycle control (like pause), not schedule config (day/time
// stays in /schedule — see CLAUDE.md's "Post-draw rating survey"). Reached via the main hub's
// "⭐ Опитування" button; "📤 Надіслати опитування зараз" descends into the existing recipient
// picker below rather than duplicating it.
function buildRatingHubText(enabled: boolean): string {
  return (
    `⭐ Опитування з оцінкою закладу\n\n` +
    `Стан: ${enabled ? 'увімкнено' : 'вимкнено'}\n\n` +
    `День і час опитування налаштовуються в /schedule → ⭐ Опитування.`
  );
}

function buildRatingHubKeyboard(chatId: number, enabled: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(enabled ? '🔕 Вимкнути' : '🔛 Увімкнути', `admin:rating_survey_toggle:${chatId}`)],
    [Markup.button.callback('📤 Надіслати опитування зараз', `admin:rating_targets:${chatId}`)],
    [Markup.button.callback('‹ Назад', `admin:select:${chatId}`)],
  ]);
}

async function renderRatingHub(ctx: Context, userId: number, chatId: number): Promise<void> {
  const enabled = isRatingSurveyEnabled(chatId);
  await panel.update(ctx, userId, buildRatingHubText(enabled), buildRatingHubKeyboard(chatId, enabled));
}

// Not rendered as HTML (parse_mode is never set for this panel, unlike group announcements), so
// placeLabel (plain-text) is used here, not placeLink.
function buildRatingSendText(chatId: number): string {
  const context = getRatingSurveyContext(chatId);
  if (!context) {
    return '⭐ Опитування про заклад\n\nЩе не було завершеного жеребкування з переможцем — нікого запитати.';
  }
  return (
    `⭐ Опитування про заклад «${placeLabel(context.winnerPlace)}»\n\n` +
    `Обери, кому надіслати (тап перемикає), або надішли всім одразу.`
  );
}

// Kept a pure render given the current selection, so both opening the screen fresh (empty Set)
// and re-rendering after a toggle (the mutated Set) go through the same builder.
function buildRatingSendKeyboard(chatId: number, selected: Set<number>) {
  const context = getRatingSurveyContext(chatId);
  if (!context) {
    return Markup.inlineKeyboard([[Markup.button.callback('‹ Назад', `admin:rating:${chatId}`)]]);
  }

  // context.recipients already excludes anyone currently blocked (getRatingSurveyContext), so a
  // since-blocked submitter never appears here as a selectable target.
  const rows = context.recipients.map((s) => [
    Markup.button.callback(
      `${selected.has(s.userId) ? '✅' : '◻️'} ${displayName(s.username, s.userId)}`,
      `admin:rating_toggle:${chatId}:${s.userId}`,
    ),
  ]);
  rows.push([Markup.button.callback('📤 Надіслати всім', `admin:rating_all:${chatId}`)]);
  if (selected.size > 0) {
    rows.push([Markup.button.callback(`✅ Надіслати обраним (${selected.size})`, `admin:rating_send:${chatId}`)]);
  }
  rows.push([Markup.button.callback('‹ Назад', `admin:rating:${chatId}`)]);
  return Markup.inlineKeyboard(rows);
}

async function renderRatingSendPanel(ctx: Context, userId: number, chatId: number, selected: Set<number>): Promise<void> {
  await panel.update(ctx, userId, buildRatingSendText(chatId), buildRatingSendKeyboard(chatId, selected));
}

function buildStatsMenuKeyboard(chatId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🏆 Топ переможців', `admin:stats_top:${chatId}`)],
    [Markup.button.callback('📈 Активність', `admin:stats_activity:${chatId}`)],
    [Markup.button.callback('‹ Назад', `admin:experimental:${chatId}`)],
  ]);
}

function buildStatsBackKeyboard(chatId: number) {
  return Markup.inlineKeyboard([[Markup.button.callback('‹ Назад', `admin:stats:${chatId}`)]]);
}

async function renderStatsMenu(ctx: Context, userId: number, chatId: number): Promise<void> {
  await panel.update(ctx, userId, '📊 Статистика цієї групи\n\nОбери, що подивитися:', buildStatsMenuKeyboard(chatId));
}

// Rendered as HTML (unlike the rest of this panel — see buildRatingSendText's comment) so every
// entry is a clickable link to the actual place, not just a label: a plain generic "заклад" label
// can't tell two different expz.menu/Maps venues apart, but a working link to each one can, even
// without a human-readable name (see placeLinkWithHint in htmlFormat.ts).
function buildTopWinnersText(chatId: number): string {
  const places = getTopWinningPlaces(chatId);
  if (places.length === 0) {
    return '🏆 Топ переможців\n\nЩе не було жодного розіграшу з переможцем.';
  }
  return `🏆 Топ переможців\n\n${places.map((p, i) => `${i + 1}. ${placeLinkWithHint(p.place)} — ${p.wins}×`).join('\n')}`;
}

async function renderTopWinnersPanel(ctx: Context, userId: number, chatId: number): Promise<void> {
  await panel.update(ctx, userId, buildTopWinnersText(chatId), buildStatsBackKeyboard(chatId), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

// Participation counts only actual place proposals (submissions_history never holds a decliner's
// row — see getTopParticipants), and rating counts only real star ratings, not "🙅 Мене не було"
// taps (see getTopRaters) — a deliberate choice, not an oversight.
function buildActivityText(chatId: number): string {
  const participants = getTopParticipants(chatId);
  const raters = getTopRaters(chatId);
  const participantsBlock =
    participants.length > 0
      ? participants.map((p, i) => `${i + 1}. ${displayName(p.username, p.userId)} — ${p.submissions}`).join('\n')
      : 'Ще ніхто не подавав заявок.';
  const ratersBlock =
    raters.length > 0
      ? raters.map((r, i) => `${i + 1}. ${displayName(r.username, r.userId)} — ${r.ratings}`).join('\n')
      : 'Ще ніхто не оцінював заклади.';
  return (
    `📈 Активність\n\n` +
    `📝 Найчастіше пропонували заклад:\n${participantsBlock}\n\n` +
    `⭐ Найчастіше оцінювали заклад:\n${ratersBlock}`
  );
}

async function renderActivityPanel(ctx: Context, userId: number, chatId: number): Promise<void> {
  await panel.update(ctx, userId, buildActivityText(chatId), buildStatsBackKeyboard(chatId));
}

async function renderAdminPanel(ctx: Context, userId: number, chatId: number): Promise<void> {
  const submissions = getAllSubmissions(chatId);
  const placeCount = submissions.filter((s) => s.status === 'submitted').length;
  const declineCount = submissions.filter((s) => s.status === 'declined').length;
  await panel.update(
    ctx,
    userId,
    buildPanelText(isGroupPaused(chatId), placeCount, declineCount, isSubmissionLocked(chatId), listBlockedUsersInGroup(chatId).length),
    buildHubKeyboard(chatId),
  );
}

export async function showAdminMenu(ctx: Context, chatId: number): Promise<void> {
  await showGatedMenu(
    ctx,
    chatId,
    {
      checkFailed: '⚠️ Не вдалося перевірити права доступу для цієї групи.',
      notAdmin: '🔒 Лише адміни групи можуть керувати циклом.',
    },
    renderAdminPanel,
  );
}

export async function handleAdminCommand(ctx: Context): Promise<void> {
  await handleAdminEntryCommand(
    ctx,
    'admin',
    {
      noAdminGroups: '🔒 Ти не адміністратор жодної групи, де я є.',
      pickGroup: 'Обери групу, циклом якої хочеш керувати:',
    },
    showAdminMenu,
  );
}

export async function handleAdminAction(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const query = ctx.callbackQuery;
  const data = query && 'data' in query ? query.data : undefined;

  if (!userId || !data) {
    if (query) await safeAnswerCbQuery(ctx);
    return;
  }

  const [, action, arg, targetArg] = data.split(':');
  const chatId = Number(arg);
  const targetUserId = targetArg !== undefined ? Number(targetArg) : undefined;

  // Every action here targets a group directly via the chatId embedded in callback_data —
  // re-verify admin status on every action, same reasoning as handleScheduleAction in
  // schedule.ts: Telegram never expires old inline buttons, so a stale panel stays pressable
  // indefinitely, and without this, someone demoted after opening /admin could still
  // pause/resume/force-draw/reopen/clear that group from an old message.
  const admin = await isGroupAdmin(ctx, chatId, userId).catch(() => false);
  if (!admin) {
    await safeAnswerCbQuery(ctx, '🔒 Лише адміни групи можуть керувати циклом.', { show_alert: true });
    return;
  }

  // "✅ Надіслати обраним" is only ever rendered once selected.size > 0, so reaching this action
  // with nothing (or stale-chat) selected means the tapped button is a leftover from an older,
  // already-acted-on render of this screen — same "stale inline button" class as schedule.ts's
  // days_done empty-selection guard, checked before the generic ack for the same reason.
  if (action === 'rating_send') {
    const selection = getRatingSelection(userId);
    if (!selection || selection.chatId !== chatId || selection.selected.size === 0) {
      await safeAnswerCbQuery(ctx, '🔄 Вибір застарів — обери когось ще раз.', { show_alert: true });
      return;
    }
  }

  await safeAnswerCbQuery(ctx);

  if (action === 'select') {
    const message = query && 'message' in query ? query.message : undefined;
    if (message) panel.track(ctx, userId, message.chat.id, message.message_id);
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  const actorName = ctx.from?.username ?? ctx.from?.first_name;

  if (action === 'cycle') {
    await renderCyclePanel(ctx, userId, chatId);
    return;
  }

  if (action === 'experimental') {
    await renderExperimentalMenu(ctx, userId, chatId);
    return;
  }

  if (action === 'diagnostics') {
    await renderDiagnosticsPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'auditlog') {
    await renderAuditLogPanel(ctx, userId, chatId, targetUserId ?? 0);
    return;
  }

  if (action === 'pause') {
    pauseGroup(chatId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'pause' });
    await renderCyclePanel(ctx, userId, chatId);
    return;
  }

  if (action === 'resume') {
    resumeGroup(chatId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'resume' });
    await renderCyclePanel(ctx, userId, chatId);
    return;
  }

  if (action === 'draw') {
    const winner = pickWeeklyWinner(chatId);
    // Computed before recordDraw persists this draw — see that function's own comment for why.
    const isRepeat = isRepeatWinner(chatId, winner);
    recordDraw(chatId, winner);
    // Same ordering as scheduler.ts's own draw branch: reset before the network send, so a
    // crash/failure during that send never leaves the chat stuck locked.
    resetWeek(chatId);
    // Marks today's draw as already fired so the scheduler's own tick doesn't run a second, empty
    // draw later the same day if this group's scheduled draw time hasn't passed yet.
    markFired(chatId, 'draw', getKyivNow().date);
    logAdminAction({
      chatId,
      actorUserId: userId,
      actorName,
      action: 'draw',
      detail: winner ? `winner:${winner.userId}` : undefined,
    });
    await sendToChat(ctx.telegram, chatId, buildDrawAnnouncement(winner, isRepeat), { parse_mode: 'HTML' });
    await renderCyclePanel(ctx, userId, chatId);
    return;
  }

  if (action === 'reopen') {
    reopenSubmissions(chatId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'reopen' });
    await renderCyclePanel(ctx, userId, chatId);
    return;
  }

  if (action === 'clearweek') {
    resetWeek(chatId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'clearweek' });
    await renderCyclePanel(ctx, userId, chatId);
    return;
  }

  if (action === 'blocklist') {
    await renderBlocklistPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'stats') {
    await renderStatsMenu(ctx, userId, chatId);
    return;
  }

  if (action === 'stats_top') {
    await renderTopWinnersPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'stats_activity') {
    await renderActivityPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'block') {
    if (targetUserId === undefined) return;
    // Looked up before blocking removes it: blockUserFromGroup drops the target's current-week
    // submission as part of blocking, so their username has to be captured from it first.
    const target = getAllSubmissions(chatId).find((s) => s.userId === targetUserId);
    blockUserFromGroup(chatId, targetUserId, target?.username, userId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'block', detail: `target:${targetUserId}` });
    await renderBlocklistPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'unblock') {
    if (targetUserId === undefined) return;
    unblockUserFromGroup(chatId, targetUserId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'unblock', detail: `target:${targetUserId}` });
    await renderBlocklistPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'rating') {
    await renderRatingHub(ctx, userId, chatId);
    return;
  }

  if (action === 'rating_survey_toggle') {
    const next = !isRatingSurveyEnabled(chatId);
    setRatingSurveyEnabled(chatId, next);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'rating_toggle', detail: next ? 'on' : 'off' });
    await renderRatingHub(ctx, userId, chatId);
    return;
  }

  if (action === 'rating_targets') {
    const selected = new Set<number>();
    setRatingSelection(userId, { chatId, selected });
    await renderRatingSendPanel(ctx, userId, chatId, selected);
    return;
  }

  if (action === 'rating_toggle') {
    if (targetUserId === undefined) return;
    const current = getRatingSelection(userId);
    const selected = current && current.chatId === chatId ? current.selected : new Set<number>();
    if (selected.has(targetUserId)) {
      selected.delete(targetUserId);
    } else {
      selected.add(targetUserId);
    }
    setRatingSelection(userId, { chatId, selected });
    await renderRatingSendPanel(ctx, userId, chatId, selected);
    return;
  }

  if (action === 'rating_all') {
    if (getRatingSurveyContext(chatId)) {
      await sendRatingSurvey(ctx.telegram, chatId);
      logAdminAction({ chatId, actorUserId: userId, actorName, action: 'send_rating_survey', detail: 'all' });
    }
    clearRatingSelection(userId);
    await renderRatingHub(ctx, userId, chatId);
    return;
  }

  if (action === 'rating_send') {
    // Non-empty selection for this chatId already confirmed above, before the generic ack.
    const selection = getRatingSelection(userId)!;
    if (getRatingSurveyContext(chatId)) {
      const targets = Array.from(selection.selected);
      await sendRatingSurvey(ctx.telegram, chatId, targets);
      logAdminAction({
        chatId,
        actorUserId: userId,
        actorName,
        action: 'send_rating_survey',
        detail: `targets:${targets.join(',')}`,
      });
    }
    clearRatingSelection(userId);
    await renderRatingHub(ctx, userId, chatId);
    return;
  }
}
