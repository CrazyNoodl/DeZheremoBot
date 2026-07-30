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
// since a group member reading this has no way to observe those from inside Telegram.
const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.1.0',
    date: '2026-07-28',
    title: 'Перший реліз',
    added: [
      'Бот сам реєструє груповий чат, щойно його туди додають — налаштовувати вручну нічого не треба.',
      'Особисте меню, подача заявки посиланням на заклад і оголошення обраного варіанта в групі.',
      'Дедлайн: закриття прийому заявок і випадкове жеребкування переможця тижня.',
    ],
    fixed: ['Виправлено регіон деплою на Fly.io — бот реально запускався в проді.'],
  },
  {
    version: '0.1.1',
    date: '2026-07-28',
    title: 'Тільки перевірені посилання',
    added: [
      'Заявка приймається лише як посилання з дозволеного списку (Google Maps, Instagram, expz.menu) — вільний текст більше не підходить.',
    ],
    improved: [
      'Ліміт довжини заявки піднято до 200 символів, посилання з параметрами (?...) тепер теж приймаються.',
    ],
  },
  {
    version: '0.1.2',
    date: '2026-07-29',
    title: 'Адмін-панель',
    added: [
      'Команда /admin: пауза й відновлення тижневого циклу, ручне жеребкування, повторне відкриття заявок, очищення поточного тижня.',
    ],
    improved: [
      'Повідомлення бота тепер з клікабельними посиланнями на заклади та випадковими емодзі — однакові щотижневі тексти не виглядають одноманітно.',
    ],
  },
  {
    version: '0.1.3',
    date: '2026-07-29',
    title: 'Блокування учасників',
    added: [
      'Можна заблокувати конкретного учасника від подачі заявок у групі (і розблокувати назад) прямо з /admin.',
    ],
  },
  {
    version: '0.1.4',
    date: '2026-07-29',
    title: 'Нагадування тегає тих, хто мовчить',
    added: [
      'Останнє нагадування перед дедлайном тепер тегає учасників, які раніше подавали заявки в цій групі, але ще не відповіли цього тижня.',
      'Кнопка «🔔 Надіслати нагадування зараз» у /schedule для ручного запуску того самого нагадування.',
    ],
    fixed: ['Заблоковані учасники більше не потрапляють у список тегнутих як "ще не відповів".'],
  },
  {
    version: '0.1.5',
    date: '2026-07-29',
    title: '«Не йду цього тижня»',
    added: [
      'Нова відповідь «не йду цього тижня» — окрема від заявки, не бере участі в жеребкуванні, скасовується новою заявкою.',
      'Кнопка «🙅 Не йду» прямо в груповому повідомленні, без переходу в приватний чат.',
    ],
  },
  {
    version: '0.1.6',
    date: '2026-07-30',
    title: 'Команда /help',
    added: ['/help пояснює весь тижневий цикл новачкам і показує актуальний розклад цієї групи.'],
  },
  {
    version: '0.1.7',
    date: '2026-07-30',
    title: 'Дедлайн у меню',
    improved: ['Особисте меню одразу показує дедлайн подачі заявок цього тижня, не гортаючи нікуди.'],
  },
  {
    version: '0.1.8',
    date: '2026-07-30',
    title: 'Захист від застарілих кнопок',
    fixed: [
      'Кнопки особистого меню більше не діють на застарілій картці — бот попереджає, що меню оновилось, і просить оновити його.',
    ],
  },
  {
    version: '0.1.9',
    date: '2026-07-30',
    title: 'Повернути скасований варіант одним тапом',
    added: [
      'Скасувавши «не йду», можна одним тапом повернути саме той варіант, який щойно відкликали, замість того щоб вводити посилання знову.',
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

// Same reasoning as /help: no admin check, no chatId resolution — the changelog is the same for
// everyone, so it just replies wherever it was typed, group or private chat alike.
export async function handleReleaseNotesCommand(ctx: Context): Promise<void> {
  await ctx.reply(buildReleaseNotesText(), { parse_mode: 'HTML' });
}
