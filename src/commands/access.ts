import { Markup, type Context } from 'telegraf';
import { getGroupChatTitle, listGroupChats } from '../storage/groupChats.js';

export async function isChatMember(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return member.status !== 'left' && member.status !== 'kicked';
  } catch {
    return false;
  }
}

export async function isGroupAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  const member = await ctx.telegram.getChatMember(chatId, userId);
  return member.status === 'creator' || member.status === 'administrator';
}

// Shared by /schedule and /admin: both have no chat-id context of their own (typed directly in a
// private chat), so both need to scan every known group to find which ones this user administers.
// A lookup failure for any one chat (bot no longer a member, API hiccup) is treated as "not admin
// there" rather than aborting the whole scan.
export async function findAdminGroupChats(ctx: Context, userId: number): Promise<number[]> {
  const adminChatIds: number[] = [];
  for (const chatId of listGroupChats()) {
    try {
      if (await isGroupAdmin(ctx, chatId, userId)) adminChatIds.push(chatId);
    } catch {
      // bot lost access to this chat, or the lookup failed — treat as "not admin there"
    }
  }
  return adminChatIds;
}

// Shared by /schedule's and /admin's group-picker screen (shown when an admin manages more than
// one group) — identical button layout, differing only in which callback namespace ("sched" vs
// "admin") the resulting tap should route through.
export function buildGroupPickerKeyboard(chatIds: number[], namespace: string) {
  return Markup.inlineKeyboard(
    chatIds.map((chatId) => [
      Markup.button.callback(getGroupChatTitle(chatId) || `Група ${chatId}`, `${namespace}:select:${chatId}`),
    ]),
  );
}

// Shared by /schedule's showScheduleMenu and /admin's showAdminMenu: both need the same
// admin-status-then-render sequence (lookup failure -> distinct error, not-admin -> distinct
// refusal, otherwise render), differing only in wording and what "render" means for that panel.
export async function showGatedMenu(
  ctx: Context,
  chatId: number,
  messages: { checkFailed: string; notAdmin: string },
  render: (ctx: Context, userId: number, chatId: number) => Promise<void>,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  let admin: boolean;
  try {
    admin = await isGroupAdmin(ctx, chatId, userId);
  } catch {
    await ctx.reply(messages.checkFailed);
    return;
  }

  if (!admin) {
    await ctx.reply(messages.notAdmin);
    return;
  }

  await render(ctx, userId, chatId);
}

// Shared by /schedule's handleScheduleCommand and /admin's handleAdminCommand: both are typed
// directly in a private chat (no chat-id context of their own), so both need the same
// private-chat-only check, then either open the panel directly (exactly one admin group) or show
// a group picker (more than one) — differing only in wording, callback namespace, and which panel
// "show" opens.
export async function handleAdminEntryCommand(
  ctx: Context,
  namespace: string,
  messages: { notPrivate: string; noAdminGroups: string; pickGroup: string },
  show: (ctx: Context, chatId: number) => Promise<void>,
): Promise<void> {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply(messages.notPrivate);
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) return;

  const adminChatIds = await findAdminGroupChats(ctx, userId);

  if (adminChatIds.length === 0) {
    await ctx.reply(messages.noAdminGroups);
    return;
  }

  if (adminChatIds.length === 1) {
    await show(ctx, adminChatIds[0]);
    return;
  }

  await ctx.reply(messages.pickGroup, buildGroupPickerKeyboard(adminChatIds, namespace));
}
