import 'dotenv/config';
import * as Sentry from '@sentry/node';
import { Telegraf } from 'telegraf';
import { handleAdminAction, handleAdminCommand } from './commands/admin.js';
import { CANCEL_AWAITING_ACTION, handleCancelAwaitingAction } from './commands/add.js';
import { handleMyChatMember, handleNewChatTitle } from './commands/groupChat.js';
import { handleHelpCommand } from './commands/help.js';
import { buildGroupMenu, DECLINE_GROUP_ACTION, START_ADD_PREFIX, START_LIST_PREFIX } from './commands/keyboard.js';
import { showSubmissionsList } from './commands/list.js';
import { handleReleaseNotesCommand } from './commands/releaseNotes.js';
import { handleRateAction } from './commands/rating.js';
import {
  DECLINE_ACTION,
  handleDeclineAction,
  handleGroupDeclineAction,
  handleResubmitDeclinedAction,
  handleSubmitAction,
  RESUBMIT_DECLINED_ACTION,
  showPersonalMenu,
  SUBMIT_ACTION,
} from './commands/menu.js';
import { handleScheduleAction, handleScheduleCommand } from './commands/schedule.js';
import { handleTextMessage } from './commands/text.js';
import { handleTimeSlotPollAction } from './commands/timeSlotPoll.js';
import { startScheduler } from './scheduler.js';
import { addGroupChat } from './storage/groupChats.js';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  });
}

const token = process.env.BOT_TOKEN;
if (!token) {
  throw new Error('BOT_TOKEN is not set in environment');
}

const bot = new Telegraf(token);

bot.start(async (ctx) => {
  if (ctx.chat.type === 'private') {
    if (ctx.startPayload?.startsWith(START_ADD_PREFIX)) {
      const chatId = Number(ctx.startPayload.slice(START_ADD_PREFIX.length));
      await showPersonalMenu(ctx, chatId);
    } else if (ctx.startPayload?.startsWith(START_LIST_PREFIX)) {
      const chatId = Number(ctx.startPayload.slice(START_LIST_PREFIX.length));
      await showSubmissionsList(ctx, chatId);
    } else {
      await ctx.reply('👋 Привіт! Я ДеЖеремоБот — допомагаю компанії визначитись, куди піти їсти. Тисни "➕ Додати" в груповому чаті, а я тут, у приватці, спитаю деталі. Команда /help розкаже, як усе працює.');
    }
    return;
  }

  addGroupChat(ctx.chat.id, ctx.chat.title); // backfills the title for chats registered before it was tracked
  await ctx.reply('Обирай дію: (команда /help у приватному чаті зі мною розкаже, як усе працює)', buildGroupMenu(ctx.botInfo.username, ctx.chat.id));
});

bot.on('my_chat_member', handleMyChatMember);
bot.on('new_chat_title', handleNewChatTitle);
bot.action(SUBMIT_ACTION, handleSubmitAction);
bot.action(DECLINE_ACTION, handleDeclineAction);
bot.action(CANCEL_AWAITING_ACTION, handleCancelAwaitingAction);
bot.action(DECLINE_GROUP_ACTION, handleGroupDeclineAction);
bot.action(RESUBMIT_DECLINED_ACTION, handleResubmitDeclinedAction);
bot.action(/^sched:/, handleScheduleAction);
bot.command('schedule', handleScheduleCommand);
bot.action(/^admin:/, handleAdminAction);
bot.command('admin', handleAdminCommand);
bot.action(/^rate:/, handleRateAction);
bot.action(/^tsp:/, handleTimeSlotPollAction);
bot.command('help', handleHelpCommand);
bot.command('releasenotes', handleReleaseNotesCommand);
bot.on('text', handleTextMessage);

bot.launch(() => {
  startScheduler(bot);
});

// Safety net: without this, an error thrown by any command/action handler had nowhere to surface —
// no logging existed anywhere in the codebase before this, so a failure would look identical to
// the bot silently doing nothing.
bot.catch((err, ctx) => {
  console.error(`[bot] unhandled error for update ${ctx.update.update_id}:`, err);
  Sentry.captureException(err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
