import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addOrUpdateTimeSlotResponse,
  clearTimeSlotResponses,
  getTimeSlotResponse,
  listTimeSlotResponses,
  removeTimeSlotResponse,
} from './timeSlotResponses.js';

test('addOrUpdateTimeSlotResponse then getTimeSlotResponse round-trips', () => {
  addOrUpdateTimeSlotResponse(-43101, 1, { days: [6, 0], daysAny: false, times: ['10:00', '11:00'], timesAny: false });

  // node:sqlite rows come back as null-prototype objects — spread into a plain object before
  // comparing, since deepEqual from node:assert/strict is an alias for deepStrictEqual and checks
  // prototypes too.
  assert.deepEqual(
    { ...getTimeSlotResponse(-43101, 1) },
    { userId: 1, days: [6, 0], daysAny: false, times: ['10:00', '11:00'], timesAny: false },
  );
});

test('addOrUpdateTimeSlotResponse overwrites the same user\'s previous answer in that chat', () => {
  addOrUpdateTimeSlotResponse(-43102, 1, { days: [6], daysAny: false, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(-43102, 1, { days: [], daysAny: true, times: [], timesAny: true });

  assert.deepEqual({ ...getTimeSlotResponse(-43102, 1) }, { userId: 1, days: [], daysAny: true, times: [], timesAny: true });
  assert.equal(listTimeSlotResponses(-43102).length, 1);
});

test('an empty days/times array round-trips as an empty array, not [NaN] or ["")]', () => {
  addOrUpdateTimeSlotResponse(-43103, 1, { days: [], daysAny: true, times: [], timesAny: false });

  assert.deepEqual(getTimeSlotResponse(-43103, 1)?.days, []);
  assert.deepEqual(getTimeSlotResponse(-43103, 1)?.times, []);
});

test('responses are isolated per chat', () => {
  addOrUpdateTimeSlotResponse(-43104, 1, { days: [6], daysAny: false, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(-43105, 1, { days: [0], daysAny: false, times: [], timesAny: false });

  assert.deepEqual(getTimeSlotResponse(-43104, 1)?.days, [6]);
  assert.deepEqual(getTimeSlotResponse(-43105, 1)?.days, [0]);
});

test('clearTimeSlotResponses only removes the given chat', () => {
  addOrUpdateTimeSlotResponse(-43106, 1, { days: [6], daysAny: false, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(-43106, 2, { days: [0], daysAny: false, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(-43107, 1, { days: [6], daysAny: false, times: [], timesAny: false });

  clearTimeSlotResponses(-43106);

  assert.deepEqual(listTimeSlotResponses(-43106), []);
  assert.equal(listTimeSlotResponses(-43107).length, 1);
});

test('removeTimeSlotResponse removes only the given user in that chat', () => {
  addOrUpdateTimeSlotResponse(-43108, 1, { days: [6], daysAny: false, times: [], timesAny: false });
  addOrUpdateTimeSlotResponse(-43108, 2, { days: [0], daysAny: false, times: [], timesAny: false });

  removeTimeSlotResponse(-43108, 1);

  assert.equal(getTimeSlotResponse(-43108, 1), undefined);
  assert.notEqual(getTimeSlotResponse(-43108, 2), undefined);
});

test('getTimeSlotResponse returns undefined for an unknown user', () => {
  assert.equal(getTimeSlotResponse(-43109, 999), undefined);
});
