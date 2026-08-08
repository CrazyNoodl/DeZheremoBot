import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDrawAnnouncement, buildFinalReminderExtra, pickRandomEmoji } from './announcements.js';

// Same technique kyivTime.test.ts uses to test getKyivNow() deterministically — pickRandomEmoji
// calls it internally to check for a seasonal pool override.
function withMockedNow(t: any, isoUtc: string, run: () => void): void {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(isoUtc).getTime() });
  run();
}

const PLACE_LINK = 'https://www.instagram.com/dezheroma';

// Mirrors announcements.ts's own THANKS_LINE_POOL — one of these must appear verbatim, since the
// credit line is now randomized rather than a single fixed string.
const THANKS_LINE_TEXTS = [
  '(дякуємо <b>artem</b> за ідею)',
  '(<b>artem</b> сьогодні у ударі)',
  '(смачного вибору, <b>artem</b>!)',
];

test('buildDrawAnnouncement mentions the place and submitter for a fresh win', () => {
  const text = buildDrawAnnouncement({ userId: 1, username: 'artem', place: PLACE_LINK, status: 'submitted' } as any);
  assert.ok(THANKS_LINE_TEXTS.some((line) => text.includes(line)));
  assert.doesNotMatch(text, /знову/);
});

test('buildDrawAnnouncement calls out a back-to-back repeat winner distinctly', () => {
  const text = buildDrawAnnouncement(
    { userId: 1, username: 'artem', place: PLACE_LINK, status: 'submitted' } as any,
    true,
  );
  assert.match(text, /знову/);
  assert.ok(THANKS_LINE_TEXTS.some((line) => text.includes(line)));
});

test('buildDrawAnnouncement reports nobody submitted when there is no winner', () => {
  const text = buildDrawAnnouncement(undefined);
  assert.match(text, /Цього тижня всі мовчали/);
});

test('buildFinalReminderExtra reports "all done" when nobody is left to tag', () => {
  const text = buildFinalReminderExtra([], 0);
  assert.match(text, /Усі вже встигли/);
});

// Mirrors announcements.ts's own NON_SUBMITTER_LEAD_POOL — the lead-in is now randomized, so tests
// below assert on the mentions/suffix suffix rather than the exact full string.
const NON_SUBMITTER_LEAD_TEXTS = ['⏰ Ще не встигли:', '⏰ Хвилинку! Ще чекаємо на:', '👋 Агов, ще не відповіли:'];

test('buildFinalReminderExtra tags known non-submitters by user id', () => {
  const text = buildFinalReminderExtra([{ userId: 42, username: 'artem' }], 0);
  assert.ok(NON_SUBMITTER_LEAD_TEXTS.some((lead) => text === `${lead} <a href="tg://user?id=42">artem</a>`));
});

test('buildFinalReminderExtra joins multiple known non-submitters', () => {
  const text = buildFinalReminderExtra(
    [
      { userId: 1, username: 'artem' },
      { userId: 2, username: 'olya' },
    ],
    0,
  );
  assert.ok(
    NON_SUBMITTER_LEAD_TEXTS.some(
      (lead) => text === `${lead} <a href="tg://user?id=1">artem</a>, <a href="tg://user?id=2">olya</a>`,
    ),
  );
});

test('buildFinalReminderExtra appends unknown members after the tagged list, singular', () => {
  const text = buildFinalReminderExtra([{ userId: 1, username: 'artem' }], 1);
  assert.ok(
    NON_SUBMITTER_LEAD_TEXTS.some(
      (lead) => text === `${lead} <a href="tg://user?id=1">artem</a> і ще 1 людина, кого я не знаю`,
    ),
  );
});

test('buildFinalReminderExtra reports only a count when there are no known non-submitters', () => {
  const text = buildFinalReminderExtra([], 3);
  assert.match(text, /^⏰ Всі, кого я знаю, вже додали/);
  assert.match(text, /3 людини/);
});

test('buildFinalReminderExtra escapes HTML-unsafe characters in a username', () => {
  const text = buildFinalReminderExtra([{ userId: 1, username: '<script>' }], 0);
  assert.ok(NON_SUBMITTER_LEAD_TEXTS.some((lead) => text === `${lead} <a href="tg://user?id=1">&lt;script&gt;</a>`));
});

test('buildFinalReminderExtra pluralizes the Ukrainian word for "people" correctly', () => {
  assert.match(buildFinalReminderExtra([], 1), /1 людина/);
  assert.match(buildFinalReminderExtra([], 2), /2 людини/);
  assert.match(buildFinalReminderExtra([], 4), /4 людини/);
  assert.match(buildFinalReminderExtra([], 5), /5 людей/);
  assert.match(buildFinalReminderExtra([], 11), /11 людей/);
  assert.match(buildFinalReminderExtra([], 12), /12 людей/);
  assert.match(buildFinalReminderExtra([], 21), /21 людина/);
});

test('pickRandomEmoji swaps in the Unity Day pool on Jan 22 Kyiv time', (t) => {
  withMockedNow(t, '2026-01-22T10:00:00Z', () => {
    assert.ok(['💙', '💛', '🇺🇦'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji swaps in the Valentine\'s Day pool on Feb 14 Kyiv time', (t) => {
  withMockedNow(t, '2026-02-14T10:00:00Z', () => {
    assert.ok(['💘', '😍', '🌹'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji swaps in the Women\'s Day pool on Mar 8 Kyiv time', (t) => {
  withMockedNow(t, '2026-03-08T10:00:00Z', () => {
    assert.ok(['🌷', '🌸', '💐'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji swaps in the April Fools pool on Apr 1 Kyiv time, wrapping back into March', (t) => {
  withMockedNow(t, '2026-04-01T10:00:00Z', () => {
    assert.ok(['🤡', '😂', '🃏'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji swaps in the Constitution Day pool on Jun 28 Kyiv time', (t) => {
  withMockedNow(t, '2026-06-28T10:00:00Z', () => {
    assert.ok(['💙', '💛', '📜'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji swaps in the Ivan Kupala pool on Jul 7 Kyiv time', (t) => {
  withMockedNow(t, '2026-07-07T10:00:00Z', () => {
    assert.ok(['🔥', '🌻', '💧'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji swaps in the Independence Day pool on Aug 24 Kyiv time', (t) => {
  withMockedNow(t, '2026-08-24T10:00:00Z', () => {
    const picked = pickRandomEmoji(['🍕']);
    assert.ok(['💙', '💛', '🇺🇦'].includes(picked));
  });
});

test('pickRandomEmoji widens the Independence Day holiday to its start edge, Aug 21', (t) => {
  withMockedNow(t, '2026-08-21T10:00:00Z', () => {
    assert.ok(['💙', '💛', '🇺🇦'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji widens the Independence Day holiday to its end edge, Aug 27', (t) => {
  withMockedNow(t, '2026-08-27T10:00:00Z', () => {
    assert.ok(['💙', '💛', '🇺🇦'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji does not extend the Independence Day window a day before its start edge', (t) => {
  withMockedNow(t, '2026-08-20T10:00:00Z', () => {
    assert.equal(pickRandomEmoji(['🍕']), '🍕');
  });
});

test('pickRandomEmoji does not extend the Independence Day window a day past its end edge', (t) => {
  withMockedNow(t, '2026-08-28T10:00:00Z', () => {
    assert.equal(pickRandomEmoji(['🍕']), '🍕');
  });
});

test('pickRandomEmoji widens Halloween to its start edge, Oct 28', (t) => {
  withMockedNow(t, '2026-10-28T10:00:00Z', () => {
    assert.ok(['🎃', '👻', '🕸️'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji widens Halloween across the month boundary to its end edge, Nov 3', (t) => {
  withMockedNow(t, '2026-11-03T10:00:00Z', () => {
    assert.ok(['🎃', '👻', '🕸️'].includes(pickRandomEmoji(['🍕'])));
  });
});

test('pickRandomEmoji does not extend the Halloween window a day past its end edge', (t) => {
  withMockedNow(t, '2026-11-04T10:00:00Z', () => {
    assert.equal(pickRandomEmoji(['🍕']), '🍕');
  });
});

test('pickRandomEmoji swaps in the New Year pool across the year boundary (wraps Dec -> Jan)', (t) => {
  withMockedNow(t, '2026-01-02T10:00:00Z', () => {
    const picked = pickRandomEmoji(['🍕']);
    assert.ok(['🎄', '🎅', '🎁', '❄️', '🥂'].includes(picked));
  });
});

test('pickRandomEmoji falls back to the given pool outside any seasonal window', (t) => {
  withMockedNow(t, '2026-03-15T10:00:00Z', () => {
    assert.equal(pickRandomEmoji(['🍕']), '🍕');
  });
});
