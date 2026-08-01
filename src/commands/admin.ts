import { Markup, type Context } from 'telegraf';
import { buildDrawAnnouncement } from '../announcements.js';
import { placeLabel } from '../htmlFormat.js';
import { handleAdminEntryCommand, isGroupAdmin, showGatedMenu } from './access.js';
import { getKyivNow } from '../kyivTime.js';
import { sendRatingSurvey } from '../scheduler.js';
import {
  blockUserFromGroup,
  getAllSubmissions,
  isGroupPaused,
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
import { getRatingSurveyContext } from '../services/ratingService.js';
import { logAdminAction } from '../storage/auditLog.js';
import { markFired } from '../storage/firedEvents.js';
import { clearRatingSelection, getRatingSelection, setRatingSelection } from '../storage/ratingSelectionState.js';
import { sendToChat } from '../telegramBroadcast.js';
import { createPanel, safeAnswerCbQuery } from './panel.js';

// Same 48h reasoning as MENU_MESSAGE_TTL_MS in menuMessage.ts / SCHEDULE_PANEL_TTL_MS in schedule.ts.
const ADMIN_PANEL_TTL_MS = 48 * 60 * 60 * 1000;

const panel = createPanel(ADMIN_PANEL_TTL_MS, 'admin');

function buildPanelText(paused: boolean, placeCount: number, declineCount: number, locked: boolean, blockedCount: number): string {
  return (
    (paused ? '⏸ Цикл призупинено — нагадування, закриття заявок і розіграш не виконуються\n\n' : '') +
    `🛠 Керування циклом цієї групи\n\n` +
    `📝 Подано заявок цього тижня: ${placeCount}${declineCount > 0 ? ` (+ ${declineCount} не йдуть)` : ''}` +
    `${locked ? ' (прийом закрито)' : ''}` +
    (blockedCount > 0 ? `\n🚫 Заблоковано користувачів: ${blockedCount}` : '')
  );
}

function buildPanelKeyboard(chatId: number) {
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
  rows.push([Markup.button.callback('🚫 Блокування учасників', `admin:blocklist:${chatId}`)]);
  rows.push([Markup.button.callback('⭐ Надіслати опитування', `admin:rating:${chatId}`)]);
  return Markup.inlineKeyboard(rows);
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
    return Markup.inlineKeyboard([[Markup.button.callback('‹ Назад', `admin:select:${chatId}`)]]);
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
  rows.push([Markup.button.callback('‹ Назад', `admin:select:${chatId}`)]);
  return Markup.inlineKeyboard(rows);
}

async function renderRatingSendPanel(ctx: Context, userId: number, chatId: number, selected: Set<number>): Promise<void> {
  await panel.update(ctx, userId, buildRatingSendText(chatId), buildRatingSendKeyboard(chatId, selected));
}

async function renderAdminPanel(ctx: Context, userId: number, chatId: number): Promise<void> {
  const submissions = getAllSubmissions(chatId);
  const placeCount = submissions.filter((s) => s.status === 'submitted').length;
  const declineCount = submissions.filter((s) => s.status === 'declined').length;
  await panel.update(
    ctx,
    userId,
    buildPanelText(isGroupPaused(chatId), placeCount, declineCount, isSubmissionLocked(chatId), listBlockedUsersInGroup(chatId).length),
    buildPanelKeyboard(chatId),
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

  if (action === 'pause') {
    pauseGroup(chatId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'pause' });
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'resume') {
    resumeGroup(chatId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'resume' });
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'draw') {
    const winner = pickWeeklyWinner(chatId);
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
    await sendToChat(ctx.telegram, chatId, buildDrawAnnouncement(winner), { parse_mode: 'HTML' });
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'reopen') {
    reopenSubmissions(chatId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'reopen' });
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'clearweek') {
    resetWeek(chatId);
    logAdminAction({ chatId, actorUserId: userId, actorName, action: 'clearweek' });
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'blocklist') {
    await renderBlocklistPanel(ctx, userId, chatId);
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
    await renderAdminPanel(ctx, userId, chatId);
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
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }
}
