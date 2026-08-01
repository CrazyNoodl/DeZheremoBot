import type { Context } from 'telegraf';

const HELP_TEXT =
  `🍽 <b>ДеЖеремоБот</b> допомагає компанії вирішити, де поїсти.\n\n` +
  `Раз на тиждень усе йде за таким сценарієм:\n\n` +
  `1️⃣ <b>Нагадування.</b> Бот пише в групу з кнопками «➕ Додати» / «📋 Список» / «🙅 Не йду». ` +
  `Останнє нагадування перед дедлайном ще й тегає тих, хто досі не відповів цього тижня.\n\n` +
  `2️⃣ <b>Заявка.</b> «➕ Додати» відкриває приватний чат з ботом — саме там (не в групі) треба ` +
  `надіслати посилання на заклад: Google Maps, Instagram або expz.menu (просто назва без посилання ` +
  `не підійде). На групу — один активний варіант; нова заявка замінює попередню.\n\n` +
  `3️⃣ <b>«Не йду».</b> Не береш участі цього тижня — тисни «🙅 Не йду» прямо в групі (або в ` +
  `особистому меню). Це виводить тебе з жеребкування, але рахується як відповідь — тож нагадування ` +
  `більше не тегатиме. Подаси новий варіант — «не йду» скасується само.\n\n` +
  `4️⃣ <b>Дедлайн.</b> У призначений час прийом заявок закривається.\n\n` +
  `5️⃣ <b>Жеребкування.</b> Одразу після дедлайну бот випадково обирає один із поданих варіантів і ` +
  `оголошує переможця в групі.\n\n` +
  `За замовчуванням: нагадування Пн/Ср/Пт о 10:00, закриття заявок Пт 18:00, жеребкування Пт 18:15 — ` +
  `але адмін групи може змінити дні й час через приватну команду /schedule, а також керувати циклом ` +
  `(пауза, форс-розіграш тощо) через /admin.\n\n` +
  `🐞 Знайшли баг або є пропозиція? Пишіть @crazy_noodl.`;

// /help only replies in a private chat with the bot now — typed in a group it's silently ignored,
// same as /admin and /schedule, so a group can't get spammed by a member retyping it repeatedly.
// It used to also render a group's actual configured schedule when typed there; that's gone along
// with group support, since there's no longer a group chat id to look one up for.
export async function handleHelpCommand(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') return;

  await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
}
