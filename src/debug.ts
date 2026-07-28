import { Markup, type Context, type Telegraf } from 'telegraf';
import { buildGroupMenu } from './commands/keyboard.js';
import { lockSubmissions, pickWeeklyWinner, resetWeek } from './services/submissionService.js';
import { getGroupChatTitle, listGroupChats } from './storage/groupChats.js';
import { sendToChat } from './telegramBroadcast.js';

type DebugAction = 'reminder' | 'lock' | 'draw' | 'reset';

const COMMAND_NAMES: Record<DebugAction, string> = {
  reminder: 'testreminder',
  lock: 'testlock',
  draw: 'testdraw',
  reset: 'testreset',
};

async function sendReminderToChat(bot: Telegraf, chatId: number): Promise<void> {
  await sendToChat(
    bot.telegram,
    chatId,
    '🍽 ДеЖеремо цього тижня! Хто ще не встиг — тисни кнопку 👇',
    buildGroupMenu(bot.botInfo!.username, chatId),
  );
}

// NOTE: does not call recordDraw — these are test-only triggers, and recording them
// would pollute the real weekly_draws history with fake data.
async function runDrawForChat(bot: Telegraf, chatId: number): Promise<string> {
  const winner = pickWeeklyWinner(chatId);
  const text = winner
    ? `🎉 ДеЖеремо цього тижня: ${winner.place}!\n(дякуємо ${winner.username} за ідею)`
    : '😴 Цього тижня всі мовчали... наступного разу точно хтось запропонує щось смачне!';
  // Same reasoning as scheduler.ts's draw branch: reset before the network send, not after, so a
  // failure/crash during the send never leaves the chat stuck locked.
  resetWeek(chatId);
  await sendToChat(bot.telegram, chatId, text);
  return text;
}

async function runDebugAction(ctx: Context, bot: Telegraf, action: DebugAction, chatId: number): Promise<void> {
  if (action === 'reminder') {
    await sendReminderToChat(bot, chatId);
    await ctx.reply('✅ testreminder sent');
  } else if (action === 'lock') {
    lockSubmissions(chatId);
    await ctx.reply('🔒 locked');
  } else if (action === 'draw') {
    const text = await runDrawForChat(bot, chatId);
    await ctx.reply(`✅ draw done, week reset\n\n${text}`);
  } else {
    resetWeek(chatId);
    await ctx.reply('✅ week reset (unlocked, submissions cleared)');
  }
}

// Same pattern as commands/schedule.ts's isGroupAdmin/findAdminGroupChats — duplicated rather
// than shared, since this whole file is TEMP scaffolding meant to be deleted wholesale before
// real use.
async function isGroupAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  const member = await ctx.telegram.getChatMember(chatId, userId);
  return member.status === 'creator' || member.status === 'administrator';
}

async function findAdminGroupChats(ctx: Context, userId: number): Promise<number[]> {
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

// A callback query can go stale between the button being pressed and this running — Telegram
// then rejects answerCbQuery with a 400, which must not crash the whole bot process.
async function safeAnswerCbQuery(ctx: Context, text?: string, extra?: { show_alert?: boolean }): Promise<void> {
  try {
    await ctx.answerCbQuery(text, extra);
  } catch {
    // stale callback query — nothing to do
  }
}

function buildGroupPickerKeyboard(action: DebugAction, chatIds: number[]) {
  return Markup.inlineKeyboard(
    chatIds.map((chatId) => [
      Markup.button.callback(getGroupChatTitle(chatId) || `Група ${chatId}`, `debug:${action}:${chatId}`),
    ]),
  );
}

// Mirrors handleScheduleCommand's private-chat + admin-group-picker flow: these commands mutate
// shared group state (lock/draw/reset), so they're typed in a private chat with the bot — same
// as /schedule — rather than in the group itself, and target whichever group the admin picks.
async function handleDebugCommand(ctx: Context, bot: Telegraf, action: DebugAction): Promise<void> {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply(`⚠️ Тестові команди пишуться в приватному чаті з ботом — напиши мені /${COMMAND_NAMES[action]} тут.`);
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
    await runDebugAction(ctx, bot, action, adminChatIds[0]);
    return;
  }

  await ctx.reply('Обери групу, для якої запустити цю тестову дію:', buildGroupPickerKeyboard(action, adminChatIds));
}

async function handleDebugAction(ctx: Context, bot: Telegraf): Promise<void> {
  const userId = ctx.from?.id;
  const query = ctx.callbackQuery;
  const data = query && 'data' in query ? query.data : undefined;

  if (!userId || !data) {
    if (query) await safeAnswerCbQuery(ctx);
    return;
  }

  const [, action, chatIdRaw] = data.split(':');
  const chatId = Number(chatIdRaw);

  const admin = await isGroupAdmin(ctx, chatId, userId).catch(() => false);
  if (!admin) {
    await safeAnswerCbQuery(ctx, '🔒 Ти більше не адмін цієї групи.', { show_alert: true });
    return;
  }

  await safeAnswerCbQuery(ctx);
  await runDebugAction(ctx, bot, action as DebugAction, chatId);
}

export function registerDebugCommands(bot: Telegraf): void {
  bot.command('testreminder', (ctx) => handleDebugCommand(ctx, bot, 'reminder'));
  bot.command('testlock', (ctx) => handleDebugCommand(ctx, bot, 'lock'));
  bot.command('testdraw', (ctx) => handleDebugCommand(ctx, bot, 'draw'));
  bot.command('testreset', (ctx) => handleDebugCommand(ctx, bot, 'reset'));
  bot.action(/^debug:/, (ctx) => handleDebugAction(ctx, bot));
}
