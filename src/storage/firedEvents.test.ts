import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasFiredToday, markFired } from './firedEvents.js';

test('hasFiredToday is false before markFired', () => {
  assert.equal(hasFiredToday(-3001, 'draw', '2026-07-28'), false);
});

test('markFired makes hasFiredToday true for that exact chat/action/date', () => {
  markFired(-3002, 'draw', '2026-07-28');
  assert.equal(hasFiredToday(-3002, 'draw', '2026-07-28'), true);
});

test('a different date is not considered fired', () => {
  markFired(-3003, 'draw', '2026-07-28');
  assert.equal(hasFiredToday(-3003, 'draw', '2026-07-29'), false);
});

test('a different chat is not considered fired', () => {
  markFired(-3004, 'draw', '2026-07-28');
  assert.equal(hasFiredToday(-3005, 'draw', '2026-07-28'), false);
});

test('a different action on the same chat/date is not considered fired', () => {
  markFired(-3006, 'draw', '2026-07-28');
  assert.equal(hasFiredToday(-3006, 'lock', '2026-07-28'), false);
});

test('marking the same chat/action again for a later date updates the stored date', () => {
  markFired(-3007, 'reminder', '2026-07-28');
  markFired(-3007, 'reminder', '2026-08-04');

  assert.equal(hasFiredToday(-3007, 'reminder', '2026-07-28'), false);
  assert.equal(hasFiredToday(-3007, 'reminder', '2026-08-04'), true);
});
