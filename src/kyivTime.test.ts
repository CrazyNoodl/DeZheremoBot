import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatKyivDateTime, getKyivNow } from './kyivTime.js';

// Expected values below were computed independently via Python's zoneinfo (Europe/Kyiv), not by
// running this module — the point is to catch a wrong timezone id, a wrong WEEKDAY_INDEX mapping,
// or a DST offset regression, not to re-derive the tz database from itself.
function withMockedNow(t: any, isoUtc: string, run: () => void): void {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(isoUtc).getTime() });
  run();
}

test('EET (winter, UTC+2): a plain midday moment maps to the same calendar day', (t) => {
  withMockedNow(t, '2024-01-15T08:00:00Z', () => {
    assert.deepEqual(getKyivNow(), { weekday: 1, time: '10:00', date: '2024-01-15' });
  });
});

test('EET (winter, UTC+2): a late-UTC moment rolls over to the next Kyiv calendar day and weekday', (t) => {
  withMockedNow(t, '2024-01-15T22:30:00Z', () => {
    assert.deepEqual(getKyivNow(), { weekday: 2, time: '00:30', date: '2024-01-16' });
  });
});

test('EEST (summer DST, UTC+3): a plain midday moment maps to the same calendar day', (t) => {
  withMockedNow(t, '2024-07-15T07:00:00Z', () => {
    assert.deepEqual(getKyivNow(), { weekday: 1, time: '10:00', date: '2024-07-15' });
  });
});

test('EEST (summer DST, UTC+3): a late-UTC moment rolls over to the next Kyiv calendar day and weekday', (t) => {
  withMockedNow(t, '2024-07-15T21:15:00Z', () => {
    assert.deepEqual(getKyivNow(), { weekday: 2, time: '00:15', date: '2024-07-16' });
  });
});

test('DST spring-forward instant: the moment just before the switch still uses the UTC+2 offset', (t) => {
  // 2024-03-31 01:00 UTC is the exact instant Kyiv springs forward from EET to EEST.
  withMockedNow(t, '2024-03-31T00:30:00Z', () => {
    assert.deepEqual(getKyivNow(), { weekday: 0, time: '02:30', date: '2024-03-31' });
  });
});

test('DST spring-forward instant: the moment just after the switch already uses the UTC+3 offset', (t) => {
  withMockedNow(t, '2024-03-31T01:30:00Z', () => {
    assert.deepEqual(getKyivNow(), { weekday: 0, time: '04:30', date: '2024-03-31' });
  });
});

test('formatKyivDateTime renders DD.MM HH:MM in Kyiv time (EET, winter)', () => {
  assert.equal(formatKyivDateTime(new Date('2024-01-15T08:00:00Z').getTime()), '15.01 10:00');
});

test('formatKyivDateTime renders DD.MM HH:MM in Kyiv time (EEST, summer)', () => {
  assert.equal(formatKyivDateTime(new Date('2024-07-15T07:00:00Z').getTime()), '15.07 10:00');
});

test('formatKyivDateTime rolls a late-UTC moment over to the next Kyiv calendar day', () => {
  assert.equal(formatKyivDateTime(new Date('2024-01-15T22:30:00Z').getTime()), '16.01 00:30');
});

test('weekday indices match Sun=0..Sat=6 across a full week', (t) => {
  // 2024-01-14 was a Sunday (EET, UTC+2) — one fixed 10:00 Kyiv moment per day, spanning Sun..Sat.
  const expected = [
    ['2024-01-14T08:00:00Z', 0],
    ['2024-01-15T08:00:00Z', 1],
    ['2024-01-16T08:00:00Z', 2],
    ['2024-01-17T08:00:00Z', 3],
    ['2024-01-18T08:00:00Z', 4],
    ['2024-01-19T08:00:00Z', 5],
    ['2024-01-20T08:00:00Z', 6],
  ] as const;

  t.mock.timers.enable({ apis: ['Date'], now: new Date(expected[0][0]).getTime() });
  for (const [isoUtc, weekday] of expected) {
    t.mock.timers.setTime(new Date(isoUtc).getTime());
    assert.equal(getKyivNow().weekday, weekday, `expected weekday ${weekday} for ${isoUtc}`);
  }
});
