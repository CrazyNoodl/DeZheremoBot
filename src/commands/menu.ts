import { Markup, type Context } from 'telegraf';
import { pickRandom } from '../messaging/announcements.js';
import { escapeHtml, placeLabel, placeLink } from '../utils/htmlFormat.js';
import { isChatMember } from './access.js';
import { PLACE_LINK_FORMAT_HINT, promptForPlace } from './add.js';
import { DECLINE_GROUP_ACTION } from './keyboard.js';
import { buildMenuKeyboard, buildMenuText, DECLINE_ACTION, sendMenuMessage, SUBMIT_ACTION, updateMenuMessage } from './menuMessage.js';
import { safeAnswerCbQuery } from './panel.js';
import {
  declinePlace,
  getDeclinedPlace,
  getUserSubmission,
  isGroupPaused,
  isSubmissionLocked,
  isUserBlocked,
  MAX_PLACE_LENGTH,
  submitPlace,
  type SubmitResult,
} from '../services/submissionService.js';
import { getMenuMessage } from '../storage/menuMessages.js';
import { sendToChat } from '../messaging/telegramBroadcast.js';

export { SUBMIT_ACTION, DECLINE_ACTION, DECLINE_GROUP_ACTION };

// Bare action (no group/place embedded in callback_data) — same reasoning as SUBMIT_ACTION/
// DECLINE_ACTION: this screen is itself the tracked private-chat menu card, so
// handleResubmitDeclinedAction below recovers the group from getMenuMessage the same way
// handleSubmitAction does.
export const RESUBMIT_DECLINED_ACTION = 'resubmit_declined';

// Exported so text.ts's rejection replies for the same two states reuse these literals instead of
// retyping them — one string each, so wording can't drift between "opening the menu while
// blocked/paused" and "typing a place while blocked/paused".
export const PAUSED_MESSAGE = '⏸ Цього тижня ДеЖеремо на паузі — заявки поки не приймаються. Скоро повернемось!';
export const BLOCKED_MESSAGE = '🚫 Тебе заблокували в цій групі — додавати заявки більше не можна.';
const LOCKED_MESSAGE = '🔒 Заявки на цей тиждень уже закрито';

// Single source of truth for this three-way message, so handleGroupDeclineAction's upfront gate
// and its post-declinePlace race-condition fallback below can't drift apart from each other.
function gateMessageFor(reason: 'blocked' | 'paused' | 'locked'): string {
  if (reason === 'blocked') return BLOCKED_MESSAGE;
  if (reason === 'paused') return PAUSED_MESSAGE;
  return LOCKED_MESSAGE;
}

const STALE_MENU_TAP_MESSAGE = '🔄 Ця картка вже застаріла — онови меню командою /start, там уже інший стан.';

// Telegram never expires old inline buttons — if the tapped message isn't the one this user's
// card is currently tracked as (storage/menuMessages.ts), something already updated the *real*
// tracked card since this one was rendered (a later action edited it in place, or it aged past
// the 48h edit window and a fresh message replaced it). Acting on a stale card's button would
// apply whatever it implies (e.g. "Скасувати «не йду»") against the *current* actual state
// instead of the state the user is looking at — e.g. tapping a stale cancel-decline button while
// you've since resubmitted a place would silently decline you again instead of doing nothing.
function isStaleMenuTap(ctx: Context, userId: number): boolean {
  const query = ctx.callbackQuery;
  const tappedMessageId = query && 'message' in query ? query.message?.message_id : undefined;
  const trackedMessageId = getMenuMessage(userId)?.messageId;
  return tappedMessageId !== undefined && trackedMessageId !== undefined && tappedMessageId !== trackedMessageId;
}

// Shared by showPersonalMenu and handleSubmitAction, which both need the exact same
// blocked → paused → locked precedence and messages before doing anything group-cycle-specific.
// Renders the relevant notice and returns true if one of these gates applies, so the caller just
// has to `return` when this returns true and fall through to its own logic otherwise.
async function renderGateIfBlocked(ctx: Context, groupChatId: number, userId: number): Promise<boolean> {
  // Checked first: a blocked user gets a distinct, permanent-sounding message rather than one
  // implying they could submit again once the week reopens or resumes.
  if (isUserBlocked(groupChatId, userId)) {
    await updateMenuMessage(ctx, groupChatId, userId, BLOCKED_MESSAGE);
    return true;
  }

  // Checked ahead of the lock check: pause and lock are independent flags, and a paused group
  // gets its own distinct message rather than the "closed for this week" lock text.
  if (isGroupPaused(groupChatId)) {
    await updateMenuMessage(ctx, groupChatId, userId, PAUSED_MESSAGE);
    return true;
  }

  if (isSubmissionLocked(groupChatId)) {
    // Edits/reuses a stale tracked card if one exists, same as every other state change in this
    // private chat, instead of always creating a fresh message.
    await updateMenuMessage(ctx, groupChatId, userId, LOCKED_MESSAGE);
    return true;
  }

  return false;
}

// Small phrase pools (same idea as announcements.ts's) for the messages a member sees most often —
// their own submit confirmation, and the group's public announcement of it.
const SUBMIT_CONFIRM_LEAD_POOL = ['Готово!', 'Ура, вийшло!', 'Прийнято!'] as const;
const NEW_SUBMIT_VERB_POOL = ['пропонує варіант', 'ділиться ідеєю', 'додає варіант'] as const;
const UPDATE_SUBMIT_VERB_POOL = ['оновлює варіант', 'змінює вибір', 'оновлює вибір'] as const;
const DECLINE_RETRACTION_POOL: readonly ((user: string, place: string) => string)[] = [
  (user, place) => `🙅 <b>${user}</b> цього тижня не йде (варіант знято: ${place})`,
  (user, place) => `🙅 <b>${user}</b> цього тижня пропускає — і забирає варіант: ${place}`,
];

// Shared by handleDeclineAction and handleGroupDeclineAction — both retract an already-announced
// place the same way, so the group-facing wording (and its pool) can't drift between the two entry
// points.
function buildDeclineRetractionAnnouncement(username: string, previousPlace: string): string {
  return pickRandom(DECLINE_RETRACTION_POOL)(escapeHtml(username), placeLink(previousPlace));
}

function buildCancelDeclineText(): string {
  return 'Плани зміняться? Можеш повернути минулий варіант або ввести нове посилання 👇';
}

// One button for the exact place this decline retracted, plus a way to type a fresh link instead
// — reusing SUBMIT_ACTION directly since this screen is itself the tracked menu card
// handleSubmitAction already knows how to read the group from.
function buildCancelDeclineKeyboard(place: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`📍 ${placeLabel(place)}`, RESUBMIT_DECLINED_ACTION)],
    [Markup.button.callback('✍️ Ввести нове посилання', SUBMIT_ACTION)],
  ]);
}

// Shared by handleDeclineAction's "cancel не йду" branch and handleResubmitDeclinedAction below — the
// exact same confirmation/rejection rendering + group announcement text.ts's handleTextMessage
// uses for a typed submission, factored out so both a typed link and a one-tap quick-pick produce
// byte-identical outcomes. retryKeyboard is only used for the too-long/invalid-format/rate-limited
// branch, since that's the one case whose keyboard differs by caller: text.ts wants the "⬅️
// Скасувати" keyboard (the user is still "awaiting" a typed reply), while a quick-pick tap has no
// such pending text state to cancel.
export async function renderSubmitOutcome(
  ctx: Context,
  groupChatId: number,
  userId: number,
  username: string,
  place: string,
  result: SubmitResult,
  retryKeyboard: ReturnType<typeof Markup.inlineKeyboard> | undefined,
): Promise<void> {
  if (!result.ok) {
    if (result.reason === 'too_long' || result.reason === 'rate_limited' || result.reason === 'invalid_format') {
      const text =
        result.reason === 'too_long'
          ? `✂️ Ого, це ціла історія! Стисни до ${MAX_PLACE_LENGTH} символів — і все вийде.`
          : result.reason === 'invalid_format'
            ? PLACE_LINK_FORMAT_HINT
            : '⏳ Не поспішай так — ще трохи і зможеш змінити знову.';
      await updateMenuMessage(ctx, groupChatId, userId, text, retryKeyboard);
      return;
    }

    const text =
      result.reason === 'locked'
        ? '🔒 Запізно — заявки на цей тиждень уже закрито. До зустрічі наступного тижня!'
        : result.reason === 'paused'
          ? PAUSED_MESSAGE
          : result.reason === 'blocked'
            ? BLOCKED_MESSAGE
            : `Це вже твій поточний варіант — міняти нічого 😉\n\n${buildMenuText(groupChatId, userId)}`;
    const keyboard =
      result.reason === 'locked' || result.reason === 'paused' || result.reason === 'blocked'
        ? undefined
        : buildMenuKeyboard(groupChatId, userId);
    await updateMenuMessage(ctx, groupChatId, userId, text, keyboard);
    return;
  }

  const previousPlace = result.previousPlace;
  const confirmLead = pickRandom(SUBMIT_CONFIRM_LEAD_POOL);
  const confirmation =
    previousPlace !== undefined
      ? `${confirmLead} Змінено на: ${placeLink(place)} (було: ${placeLink(previousPlace)}) 👍`
      : `${confirmLead} Додано: ${placeLink(place)} 🎉`;

  await updateMenuMessage(
    ctx,
    groupChatId,
    userId,
    `${confirmation}\n\n${buildMenuText(groupChatId, userId)}`,
    buildMenuKeyboard(groupChatId, userId),
  );
  await sendToChat(
    ctx.telegram,
    groupChatId,
    previousPlace !== undefined
      ? `🔄 <b>${escapeHtml(username)}</b> ${pickRandom(UPDATE_SUBMIT_VERB_POOL)}: ${placeLink(place)}`
      : `🍽 <b>${escapeHtml(username)}</b> ${pickRandom(NEW_SUBMIT_VERB_POOL)}: ${placeLink(place)}`,
    { parse_mode: 'HTML' },
  );
}

export async function showPersonalMenu(ctx: Context, groupChatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!(await isChatMember(ctx, groupChatId, userId))) {
    await ctx.reply('🔒 Здається, ти не в цій групі.');
    return;
  }

  if (await renderGateIfBlocked(ctx, groupChatId, userId)) return;

  await sendMenuMessage(ctx, groupChatId, userId, buildMenuText(groupChatId, userId));
}

export async function handleSubmitAction(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const groupChatId = userId !== undefined ? getMenuMessage(userId)?.groupChatId : undefined;
  if (!userId || groupChatId === undefined) {
    if (ctx.callbackQuery) await safeAnswerCbQuery(ctx);
    return;
  }

  if (isStaleMenuTap(ctx, userId)) {
    await safeAnswerCbQuery(ctx, STALE_MENU_TAP_MESSAGE, { show_alert: true });
    return;
  }

  await safeAnswerCbQuery(ctx);

  // Re-checked here, not just at showPersonalMenu time — the tracked menu card can outlive the
  // user's membership if they left the group after opening it (same reasoning as schedule.ts's
  // double admin-check).
  if (!(await isChatMember(ctx, groupChatId, userId))) {
    await ctx.reply('🔒 Здається, ти вже не в цій групі.');
    return;
  }

  if (await renderGateIfBlocked(ctx, groupChatId, userId)) return;

  await promptForPlace(ctx, groupChatId);
}

// Toggles "не йду цього тижня" from the personal menu's second button.
export async function handleDeclineAction(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const groupChatId = userId !== undefined ? getMenuMessage(userId)?.groupChatId : undefined;
  if (!userId || groupChatId === undefined) {
    if (ctx.callbackQuery) await safeAnswerCbQuery(ctx);
    return;
  }

  if (isStaleMenuTap(ctx, userId)) {
    await safeAnswerCbQuery(ctx, STALE_MENU_TAP_MESSAGE, { show_alert: true });
    return;
  }

  await safeAnswerCbQuery(ctx);

  if (!(await isChatMember(ctx, groupChatId, userId))) {
    await ctx.reply('🔒 Здається, ти вже не в цій групі.');
    return;
  }

  if (await renderGateIfBlocked(ctx, groupChatId, userId)) return;

  const username = ctx.from?.username ?? ctx.from?.first_name ?? 'Хтось';
  const result = declinePlace(groupChatId, userId, username);

  if (result.ok && !result.declined) {
    // Cancelling "не йду" means the user is coming after all and has no place submitted either
    // (declining always drops any previous place) — a place is exactly what's missing now. If
    // this decline retracted a real place, offer that exact one back as a one-tap shortcut
    // instead of always forcing a retyped link; with nothing to offer, fall through to the same
    // "send me a link" prompt as SUBMIT_ACTION.
    const declinedPlace = getDeclinedPlace(groupChatId, userId);
    if (declinedPlace !== undefined) {
      await updateMenuMessage(ctx, groupChatId, userId, buildCancelDeclineText(), buildCancelDeclineKeyboard(declinedPlace));
      return;
    }
    await promptForPlace(ctx, groupChatId);
    return;
  }

  if (result.ok && result.previousPlace !== undefined) {
    // Declining overwrote a place the group already saw announced — tell the group it's been
    // retracted. A decline with nothing to retract (result.previousPlace undefined) stays silent:
    // the group was never told about this user in the first place, so there's nothing to correct.
    await sendToChat(ctx.telegram, groupChatId, buildDeclineRetractionAnnouncement(username, result.previousPlace), {
      parse_mode: 'HTML',
    });
  }

  await updateMenuMessage(ctx, groupChatId, userId, buildMenuText(groupChatId, userId), buildMenuKeyboard(groupChatId, userId));
}

// Unlike handleDeclineAction above, this is deliberately one-way ("record не йду"), not a toggle —
// fired straight from the group's own reminder/menu message rather than the private-chat personal
// menu, so no deep link is needed (a callback query fired from a group message already carries
// that group as ctx.chat). A shared group button can't change its own label per viewer the way
// the private menu's can (Telegram renders one keyboard for everyone who sees the message), so a
// second tap here must not silently cancel an already-recorded decline with no visible sign it
// just happened — it stays a no-op confirmation instead. Reversing a decline still works, just not
// through this button: submitting a real place (via "➕ Додати" in the private chat) already
// overwrites a decline automatically, same as it always has. All feedback (idempotent confirm,
// success, or blocked/paused/locked) goes out as a private answerCbQuery toast, since this shared
// message can't be edited into a per-user confirmation card either.
export async function handleGroupDeclineAction(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;

  if (!(await isChatMember(ctx, chatId, userId))) {
    await safeAnswerCbQuery(ctx, '🔒 Здається, ти вже не в цій групі.', { show_alert: true });
    return;
  }

  const gateReason = isUserBlocked(chatId, userId) ? 'blocked' : isGroupPaused(chatId) ? 'paused' : isSubmissionLocked(chatId) ? 'locked' : undefined;
  if (gateReason) {
    await safeAnswerCbQuery(ctx, gateMessageFor(gateReason), { show_alert: true });
    return;
  }

  if (getUserSubmission(chatId, userId)?.status === 'declined') {
    await safeAnswerCbQuery(ctx, '🙅 Ти вже позначив(-ла), що не йдеш цього тижня.');
    return;
  }

  const username = ctx.from?.username ?? ctx.from?.first_name ?? 'Хтось';
  const result = declinePlace(chatId, userId, username);

  if (!result.ok) {
    // Rare race — state changed between the checks above and this call. Same messages as above.
    await safeAnswerCbQuery(ctx, gateMessageFor(result.reason), { show_alert: true });
    return;
  }

  if (result.previousPlace !== undefined) {
    await sendToChat(ctx.telegram, chatId, buildDeclineRetractionAnnouncement(username, result.previousPlace), {
      parse_mode: 'HTML',
    });
  }

  await safeAnswerCbQuery(ctx, '🙅 Записано: не йдеш цього тижня.');
}

// One-tap resubmission of the exact place the current decline retracted (buildCancelDeclineKeyboard
// above) — mirrors handleSubmitAction's shape (bare action, group recovered from the tracked menu
// message) since this quick-pick screen is itself that same tracked card.
export async function handleResubmitDeclinedAction(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const groupChatId = userId !== undefined ? getMenuMessage(userId)?.groupChatId : undefined;
  if (!userId || groupChatId === undefined) {
    if (ctx.callbackQuery) await safeAnswerCbQuery(ctx);
    return;
  }

  if (isStaleMenuTap(ctx, userId)) {
    await safeAnswerCbQuery(ctx, STALE_MENU_TAP_MESSAGE, { show_alert: true });
    return;
  }

  await safeAnswerCbQuery(ctx);

  if (!(await isChatMember(ctx, groupChatId, userId))) {
    await ctx.reply('🔒 Здається, ти вже не в цій групі.');
    return;
  }

  if (await renderGateIfBlocked(ctx, groupChatId, userId)) return;

  // Gone (already used, or the week reset since this screen was shown) — nothing to resubmit, so
  // fall back to the normal "send me a link" prompt instead of silently doing nothing.
  const place = getDeclinedPlace(groupChatId, userId);
  if (place === undefined) {
    await promptForPlace(ctx, groupChatId);
    return;
  }

  const username = ctx.from?.username ?? ctx.from?.first_name ?? 'Хтось';
  const result = submitPlace(groupChatId, userId, username, place);
  await renderSubmitOutcome(ctx, groupChatId, userId, username, place, result, buildMenuKeyboard(groupChatId, userId));
}
