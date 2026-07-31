import type { Context } from 'telegraf';

interface ReleaseNote {
  version: string;
  date: string;
  title: string;
  added?: string[];
  improved?: string[];
  fixed?: string[];
}

// Ascending, oldest first — kept in the same order features actually shipped, so this file itself
// doubles as a chronological changelog. Only user-facing changes are listed here; pure infra/CI/test
// commits (Fly.io auto-deploy, refactors, added test coverage, Sentry wiring) don't get an entry,
// since a group member reading this has no way to observe those from inside Telegram. One entry per
// release date — everything shipped the same day is one version, not one entry per commit, since a
// changelog reader cares about "what changed that day," not how many individual PRs it took.
const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.1.0',
    date: '2026-07-28',
    title: 'Перший реліз',
    added: [
      'Бот сам реєструє груповий чат, щойно його туди додають — налаштовувати вручну нічого не треба.',
      'Особисте меню, подача заявки посиланням на заклад і оголошення обраного варіанта в групі.',
      'Дедлайн: закриття прийому заявок і випадкове жеребкування переможця тижня.',
      'Заявка приймається лише як посилання з дозволеного списку (Google Maps, Instagram, expz.menu) — вільний текст більше не підходить.',
    ],
    improved: ['Ліміт довжини заявки піднято до 200 символів, посилання з параметрами (?...) тепер теж приймаються.'],
    fixed: ['Виправлено регіон деплою на Fly.io — бот реально запускався в проді.'],
  },
  {
    version: '0.1.1',
    date: '2026-07-29',
    title: 'Адмін-панель, блокування та нагадування, що не мовчать',
    added: [
      'Команда /admin: пауза й відновлення тижневого циклу, ручне жеребкування, повторне відкриття заявок, очищення поточного тижня.',
      'Можна заблокувати конкретного учасника від подачі заявок у групі (і розблокувати назад) прямо з /admin.',
      'Останнє нагадування перед дедлайном тепер тегає учасників, які раніше подавали заявки в цій групі, але ще не відповіли цього тижня.',
      'Кнопка «🔔 Надіслати нагадування зараз» у /schedule для ручного запуску того самого нагадування.',
      'Нова відповідь «не йду цього тижня» — окрема від заявки, не бере участі в жеребкуванні, скасовується новою заявкою.',
      'Кнопка «🙅 Не йду» прямо в груповому повідомленні, без переходу в приватний чат.',
    ],
    improved: [
      'Повідомлення бота тепер з клікабельними посиланнями на заклади та випадковими емодзі — однакові щотижневі тексти не виглядають одноманітно.',
    ],
    fixed: ['Заблоковані учасники більше не потрапляють у список тегнутих як "ще не відповів".'],
  },
  {
    version: '0.1.2',
    date: '2026-07-30',
    title: '/help, дедлайн у меню та захист від застарілих кнопок',
    added: [
      '/help пояснює весь тижневий цикл новачкам і показує актуальний розклад цієї групи.',
      'Скасувавши «не йду», можна одним тапом повернути саме той варіант, який щойно відкликали, замість того щоб вводити посилання знову.',
    ],
    improved: ['Особисте меню одразу показує дедлайн подачі заявок цього тижня, не гортаючи нікуди.'],
    fixed: [
      'Кнопки особистого меню більше не діють на застарілій картці — бот попереджає, що меню оновилось, і просить оновити його.',
    ],
  },
  {
    version: '0.1.3',
    date: '2026-08-01',
    title: 'Команди — тільки в приватному чаті',
    improved: [
      '/schedule, /admin, /help і /releasenotes тепер працюють лише в приватному чаті з ботом: у групі вони нічого не відповідають і більше не з’являються в підказці «/», щоб випадкове чи повторне введення не спамило групу. /start у групі й далі відкриває меню бота, як і раніше.',
    ],
  },
];

function buildSection(label: string, items: string[] | undefined): string {
  if (!items || items.length === 0) return '';
  return `${label}\n${items.map((item) => `• ${item}`).join('\n')}\n`;
}

function buildReleaseNoteBlock(note: ReleaseNote): string {
  const sections = [
    buildSection('🆕 Додано:', note.added),
    buildSection('✨ Покращено:', note.improved),
    buildSection('🛠 Виправлено:', note.fixed),
  ]
    .filter(Boolean)
    .join('\n');

  return `<b>${note.version}</b> — ${note.title} <i>(${note.date})</i>\n${sections}`;
}

function buildReleaseNotesText(): string {
  // Newest first — that's the order a changelog reader actually wants, even though the array above
  // is stored oldest-first so it also reads as a plain chronological history in source.
  const blocks = [...RELEASE_NOTES].reverse().map(buildReleaseNoteBlock);
  return `🗒 <b>Історія оновлень ДеЖеремоБота</b>\n\n${blocks.join('\n')}`;
}

// Only replies in a private chat with the bot — typed in a group it's silently ignored, same as
// /help, /admin, and /schedule, so a group can't get spammed by a member retyping it repeatedly.
export async function handleReleaseNotesCommand(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') return;

  await ctx.reply(buildReleaseNotesText(), { parse_mode: 'HTML' });
}
