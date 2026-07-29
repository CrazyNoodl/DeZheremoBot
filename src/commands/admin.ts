import { Markup, TelegramError, type Context } from 'telegraf';
import { buildDrawAnnouncement } from '../announcements.js';
import { findAdminGroupChats, isGroupAdmin } from './access.js';
import { getGroupChatTitle } from '../storage/groupChats.js';
import {
  clearAdminMenuMessage,
  getAdminMenuMessage,
  setAdminMenuMessage,
} from '../storage/adminMenuMessages.js';
import { getKyivNow } from '../kyivTime.js';
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
import { markFired } from '../storage/firedEvents.js';
import { sendToChat } from '../telegramBroadcast.js';

// Same 48h reasoning as MENU_MESSAGE_TTL_MS in menuMessage.ts / SCHEDULE_PANEL_TTL_MS in schedule.ts.
const ADMIN_PANEL_TTL_MS = 48 * 60 * 60 * 1000;

function buildPanelText(paused: boolean, submissionCount: number, locked: boolean, blockedCount: number): string {
  return (
    (paused ? '⏸ Цикл призупинено — нагадування, закриття заявок і розіграш не виконуються\n\n' : '') +
    `🛠 Керування циклом цієї групи\n\n` +
    `📝 Подано заявок цього тижня: ${submissionCount}${locked ? ' (прийом закрито)' : ''}` +
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
    `\n\nБлокувати можна серед тих, хто подав заявку цього тижня — натисни на ім'я нижче.`
  );
}

// Only current-week submitters can be offered for blocking here: there is no persistent
// directory of everyone who's ever used the bot, just this week's submissions table.
function buildBlocklistKeyboard(chatId: number) {
  const blocked = listBlockedUsersInGroup(chatId);
  const blockedIds = new Set(blocked.map((b) => b.userId));
  const rows = getAllSubmissions(chatId)
    .filter((s) => !blockedIds.has(s.userId))
    .map((s) => [Markup.button.callback(`🚫 ${displayName(s.username, s.userId)}`, `admin:block:${chatId}:${s.userId}`)]);
  blocked.forEach((b) => {
    rows.push([
      Markup.button.callback(`✅ Розблокувати ${displayName(b.username, b.userId)}`, `admin:unblock:${chatId}:${b.userId}`),
    ]);
  });
  rows.push([Markup.button.callback('‹ Назад', `admin:select:${chatId}`)]);
  return Markup.inlineKeyboard(rows);
}

async function renderBlocklistPanel(ctx: Context, userId: number, chatId: number): Promise<void> {
  await updateAdminPanel(ctx, userId, buildBlocklistText(chatId), buildBlocklistKeyboard(chatId));
}

function trackAdminPanel(ctx: Context, userId: number, chatId: number, messageId: number): void {
  setAdminMenuMessage(userId, chatId, messageId);
  setTimeout(() => {
    const ref = getAdminMenuMessage(userId);
    if (ref?.messageId !== messageId) return; // superseded by a newer panel message already
    clearAdminMenuMessage(userId);
    ctx.telegram.deleteMessage(chatId, messageId).catch(() => {});
  }, ADMIN_PANEL_TTL_MS);
}

async function sendAdminPanel(
  ctx: Context,
  userId: number,
  text: string,
  keyboard: ReturnType<typeof Markup.inlineKeyboard>,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sent = await ctx.reply(text, keyboard);
  trackAdminPanel(ctx, userId, chatId, sent.message_id);
}

async function updateAdminPanel(
  ctx: Context,
  userId: number,
  text: string,
  keyboard: ReturnType<typeof Markup.inlineKeyboard>,
): Promise<void> {
  const ref = getAdminMenuMessage(userId);

  if (ref) {
    try {
      await ctx.telegram.editMessageText(ref.chatId, ref.messageId, undefined, text, keyboard);
      return;
    } catch (err) {
      // Telegram rejects an edit whose text+keyboard exactly match the current message —
      // that's a no-op, not a failure, so don't fall through to sending a duplicate.
      if (err instanceof TelegramError && err.description?.includes('message is not modified')) {
        return;
      }
      console.warn(`[admin] panel edit failed for user ${userId}, sending a fresh message instead:`, err);
    }
  }

  await sendAdminPanel(ctx, userId, text, keyboard);
}

// A callback query can go stale (old message, or already answered) between the button being
// pressed and this running — Telegram then rejects answerCbQuery with a 400, which must not be
// allowed to crash the whole bot process.
async function safeAnswerCbQuery(ctx: Context, text?: string, extra?: { show_alert?: boolean }): Promise<void> {
  try {
    await ctx.answerCbQuery(text, extra);
  } catch {
    // stale callback query — nothing to do
  }
}

async function renderAdminPanel(ctx: Context, userId: number, chatId: number): Promise<void> {
  await updateAdminPanel(
    ctx,
    userId,
    buildPanelText(
      isGroupPaused(chatId),
      getAllSubmissions(chatId).length,
      isSubmissionLocked(chatId),
      listBlockedUsersInGroup(chatId).length,
    ),
    buildPanelKeyboard(chatId),
  );
}

export async function showAdminMenu(ctx: Context, chatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  let admin: boolean;
  try {
    admin = await isGroupAdmin(ctx, chatId, userId);
  } catch {
    await ctx.reply('⚠️ Не вдалося перевірити права доступу для цієї групи.');
    return;
  }

  if (!admin) {
    await ctx.reply('🔒 Лише адміни групи можуть керувати циклом.');
    return;
  }

  await renderAdminPanel(ctx, userId, chatId);
}

function buildGroupPickerKeyboard(chatIds: number[]) {
  return Markup.inlineKeyboard(
    chatIds.map((chatId) => [
      Markup.button.callback(getGroupChatTitle(chatId) || `Група ${chatId}`, `admin:select:${chatId}`),
    ]),
  );
}

export async function handleAdminCommand(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('🛠 Керувати циклом можна лише у приватному чаті з ботом — напиши мені /admin тут.');
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) return;

  const adminChatIds = await findAdminGroupChats(ctx, userId);

  if (adminChatIds.length === 0) {
    await ctx.reply('🔒 Ти не адміністратор жодної групи, де я є.');
    return;
  }

  if (adminChatIds.length === 1) {
    await showAdminMenu(ctx, adminChatIds[0]);
    return;
  }

  await ctx.reply('Обери групу, циклом якої хочеш керувати:', buildGroupPickerKeyboard(adminChatIds));
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

  await safeAnswerCbQuery(ctx);

  if (action === 'select') {
    const message = query && 'message' in query ? query.message : undefined;
    if (message) trackAdminPanel(ctx, userId, message.chat.id, message.message_id);
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'pause') {
    pauseGroup(chatId);
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'resume') {
    resumeGroup(chatId);
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
    await sendToChat(ctx.telegram, chatId, buildDrawAnnouncement(winner), { parse_mode: 'HTML' });
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'reopen') {
    reopenSubmissions(chatId);
    await renderAdminPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'clearweek') {
    resetWeek(chatId);
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
    await renderBlocklistPanel(ctx, userId, chatId);
    return;
  }

  if (action === 'unblock') {
    if (targetUserId === undefined) return;
    unblockUserFromGroup(chatId, targetUserId);
    await renderBlocklistPanel(ctx, userId, chatId);
    return;
  }
}
