import assert from 'node:assert/strict';
import { test } from 'node:test';
import { msSinceLastSubmit, recordSubmitTime } from './rateLimit.js';

test('msSinceLastSubmit is Infinity when nothing was recorded yet', () => {
  assert.equal(msSinceLastSubmit(-4001, 1), Infinity);
});

test('msSinceLastSubmit tracks elapsed fake time since recordSubmitTime, per (chat, user)', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  recordSubmitTime(-4002, 1);
  assert.equal(msSinceLastSubmit(-4002, 1), 0);

  t.mock.timers.tick(5_000);
  assert.equal(msSinceLastSubmit(-4002, 1), 5_000);

  t.mock.timers.tick(5_000);
  assert.equal(msSinceLastSubmit(-4002, 1), 10_000);

  // a different chat/user pair is unaffected
  assert.equal(msSinceLastSubmit(-4002, 2), Infinity);
  assert.equal(msSinceLastSubmit(-4003, 1), Infinity);
});

test('recordSubmitTime prunes entries older than an hour so the map does not grow forever', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  recordSubmitTime(-4004, 1);
  assert.equal(msSinceLastSubmit(-4004, 1), 0);

  t.mock.timers.tick(61 * 60 * 1000);
  // Writing a new entry sweeps stale ones — the hour-old (-4004, 1) entry is gone, so it reads
  // as "never submitted" (Infinity) again rather than an ever-growing elapsed time.
  recordSubmitTime(-4005, 2);

  assert.equal(msSinceLastSubmit(-4004, 1), Infinity);
  assert.equal(msSinceLastSubmit(-4005, 2), 0);
});
