import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFinalReminderExtra } from './announcements.js';

test('buildFinalReminderExtra reports "all done" when nobody is left to tag', () => {
  const text = buildFinalReminderExtra([], 0);
  assert.match(text, /Усі вже встигли/);
});

test('buildFinalReminderExtra tags known non-submitters by user id', () => {
  const text = buildFinalReminderExtra([{ userId: 42, username: 'artem' }], 0);
  assert.equal(text, '⏰ Ще не встигли: <a href="tg://user?id=42">artem</a>');
});

test('buildFinalReminderExtra joins multiple known non-submitters', () => {
  const text = buildFinalReminderExtra(
    [
      { userId: 1, username: 'artem' },
      { userId: 2, username: 'olya' },
    ],
    0,
  );
  assert.equal(
    text,
    '⏰ Ще не встигли: <a href="tg://user?id=1">artem</a>, <a href="tg://user?id=2">olya</a>',
  );
});

test('buildFinalReminderExtra appends unknown members after the tagged list, singular', () => {
  const text = buildFinalReminderExtra([{ userId: 1, username: 'artem' }], 1);
  assert.equal(text, '⏰ Ще не встигли: <a href="tg://user?id=1">artem</a> і ще 1 людина, кого я не знаю');
});

test('buildFinalReminderExtra reports only a count when there are no known non-submitters', () => {
  const text = buildFinalReminderExtra([], 3);
  assert.match(text, /^⏰ Всі, кого я знаю, вже додали/);
  assert.match(text, /3 людини/);
});

test('buildFinalReminderExtra escapes HTML-unsafe characters in a username', () => {
  const text = buildFinalReminderExtra([{ userId: 1, username: '<script>' }], 0);
  assert.equal(text, '⏰ Ще не встигли: <a href="tg://user?id=1">&lt;script&gt;</a>');
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
