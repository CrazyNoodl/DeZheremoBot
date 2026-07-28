import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { handleMyChatMember, handleNewChatTitle } from './commands/groupChat.js';
import { buildGroupMenu, START_ADD_PREFIX, START_LIST_PREFIX } from './commands/keyboard.js';
import { showSubmissionsList } from './commands/list.js';
import { handleSubmitAction, showPersonalMenu, SUBMIT_ACTION } from './commands/menu.js';
import { handleScheduleAction, handleScheduleCommand } from './commands/schedule.js';
import { handleTextMessage } from './commands/text.js';
import { registerDebugCommands, startDebugServer } from './debug.js';
import { startScheduler } from './scheduler.js';
import { addGroupChat } from './storage/groupChats.js';

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
      await ctx.reply('Привіт! Тисни "➕ Додати" в груповому чаті — я попрошу назву місця тут, у приватці.');
    }
    return;
  }

  addGroupChat(ctx.chat.id, ctx.chat.title); // backfills the title for chats registered before it was tracked
  await ctx.reply('Обирай дію:', buildGroupMenu(ctx.botInfo.username, ctx.chat.id));
});

bot.on('my_chat_member', handleMyChatMember);
bot.on('new_chat_title', handleNewChatTitle);
bot.action(SUBMIT_ACTION, handleSubmitAction);
bot.action(/^sched:/, handleScheduleAction);
bot.command('schedule', handleScheduleCommand);
registerDebugCommands(bot); // TEMP: for manual testing, remove before real use
bot.on('text', handleTextMessage);

bot.launch(() => {
  startScheduler(bot);
  startDebugServer(bot); // TEMP: for manual testing, remove before real use
});

// Safety net: without this, an error thrown by any command/action handler had nowhere to surface —
// no logging existed anywhere in the codebase before this, so a failure would look identical to
// the bot silently doing nothing.
bot.catch((err, ctx) => {
  console.error(`[bot] unhandled error for update ${ctx.update.update_id}:`, err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
