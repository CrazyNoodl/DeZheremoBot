import type { Context } from 'telegraf';
import { getSchedule, type GroupScheduleConfig } from '../services/scheduleService.js';

// Same weekday labeling as schedule.ts's summary panel — duplicated rather than shared, since it's
// two short const arrays and the two files have no other reason to depend on each other.
const WEEKDAY_LABELS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function formatWeekdays(weekdays: number[]): string {
  return WEEK_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => WEEKDAY_LABELS[day])
    .join(', ');
}

function buildScheduleLine(config: GroupScheduleConfig): string {
  return (
    `📅 У <b>цій групі</b> зараз так: нагадування — ${formatWeekdays(config.reminderWeekdays)} о ${config.reminderTime}, ` +
    `закриття заявок і жеребкування — ${WEEKDAY_LABELS[config.deadlineWeekday]} о ${config.lockTime} і ${config.drawTime} відповідно.\n\n`
  );
}

// /help works the same in a group and in a private chat with the bot — unlike /schedule and /admin,
// it needs no admin check or chatId resolution, so it just replies wherever it was typed. When typed
// in a group, it additionally shows that group's own actual schedule (getSchedule(ctx.chat.id)) instead
// of only the generic default, since a group's admin may have customized it via /schedule.
export async function handleHelpCommand(ctx: Context): Promise<void> {
  const scheduleLine = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
    ? buildScheduleLine(getSchedule(ctx.chat.id))
    : '';

  const text =
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
    scheduleLine +
    `За замовчуванням: нагадування Пн/Ср/Пт о 10:00, закриття заявок Пт 18:00, жеребкування Пт 18:15 — ` +
    `але адмін групи може змінити дні й час через приватну команду /schedule, а також керувати циклом ` +
    `(пауза, форс-розіграш тощо) через /admin.`;

  await ctx.reply(text, { parse_mode: 'HTML' });
}
