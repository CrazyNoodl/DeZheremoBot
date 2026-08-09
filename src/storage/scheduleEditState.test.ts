import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearScheduleEditState,
  getScheduleEditState,
  setScheduleEditState,
} from './scheduleEditState.js';

test('getScheduleEditState returns undefined for a userId never set', () => {
  assert.equal(getScheduleEditState(21001), undefined);
});

test('round-trips a reminder/weekdays state, including the Set', () => {
  const userId = 21002;
  setScheduleEditState(userId, {
    flow: 'reminder',
    step: 'weekdays',
    chatId: -21002,
    selected: new Set([1, 3, 5]),
  });

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'reminder' && state.step === 'weekdays');
  if (state?.flow === 'reminder' && state.step === 'weekdays') {
    assert.equal(state.chatId, -21002);
    assert.ok(state.selected instanceof Set);
    assert.equal(state.selected.has(1), true);
    assert.equal(state.selected.has(3), true);
    assert.equal(state.selected.has(5), true);
    assert.equal(state.selected.has(2), false);
    assert.equal(state.selected.size, 3);
  }
});

test('round-trips a reminder/time state', () => {
  const userId = 21003;
  setScheduleEditState(userId, {
    flow: 'reminder',
    step: 'time',
    chatId: -21003,
    weekdays: [2, 4],
  });

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'reminder' && state.step === 'time');
  if (state?.flow === 'reminder' && state.step === 'time') {
    assert.equal(state.chatId, -21003);
    assert.deepEqual(state.weekdays, [2, 4]);
  }
});

test('round-trips a deadline/weekday state', () => {
  const userId = 21004;
  setScheduleEditState(userId, {
    flow: 'deadline',
    step: 'weekday',
    chatId: -21004,
  });

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'deadline' && state.step === 'weekday');
  if (state?.flow === 'deadline' && state.step === 'weekday') {
    assert.equal(state.chatId, -21004);
  }
});

test('round-trips a deadline/lockTime state', () => {
  const userId = 21005;
  setScheduleEditState(userId, {
    flow: 'deadline',
    step: 'lockTime',
    chatId: -21005,
    weekday: 5,
  });

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'deadline' && state.step === 'lockTime');
  if (state?.flow === 'deadline' && state.step === 'lockTime') {
    assert.equal(state.chatId, -21005);
    assert.equal(state.weekday, 5);
  }
});

test('round-trips a deadline/drawTime state', () => {
  const userId = 21006;
  setScheduleEditState(userId, {
    flow: 'deadline',
    step: 'drawTime',
    chatId: -21006,
    weekday: 5,
    lockTime: '18:00',
  });

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'deadline' && state.step === 'drawTime');
  if (state?.flow === 'deadline' && state.step === 'drawTime') {
    assert.equal(state.chatId, -21006);
    assert.equal(state.weekday, 5);
    assert.equal(state.lockTime, '18:00');
  }
});

test('state is isolated per user', () => {
  const userA = 21007;
  const userB = 21008;
  setScheduleEditState(userA, { flow: 'deadline', step: 'weekday', chatId: -21007 });

  assert.equal(getScheduleEditState(userB), undefined);
});

test('setScheduleEditState overwrites a previous state from a different flow/step entirely', () => {
  const userId = 21009;
  setScheduleEditState(userId, { flow: 'deadline', step: 'weekday', chatId: -21009 });
  setScheduleEditState(userId, {
    flow: 'reminder',
    step: 'weekdays',
    chatId: -21009,
    selected: new Set([2]),
  });

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'reminder' && state.step === 'weekdays');
  if (state?.flow === 'reminder' && state.step === 'weekdays') {
    assert.equal(state.chatId, -21009);
    assert.equal(state.selected.has(2), true);
    assert.equal(state.selected.size, 1);
  }
});

test('clearScheduleEditState makes getScheduleEditState return undefined again', () => {
  const userId = 21010;
  setScheduleEditState(userId, { flow: 'deadline', step: 'weekday', chatId: -21010 });
  assert.notEqual(getScheduleEditState(userId), undefined);

  clearScheduleEditState(userId);
  assert.equal(getScheduleEditState(userId), undefined);
});

test('clearScheduleEditState on a user never set does not throw', () => {
  assert.doesNotThrow(() => clearScheduleEditState(21011));
});

test('round-trips a timeslot_days state, including the Set', () => {
  const userId = 21012;
  setScheduleEditState(userId, { flow: 'timeslot_days', chatId: -21012, selected: new Set([6, 0]) });

  const state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'timeslot_days');
  if (state?.flow === 'timeslot_days') {
    assert.equal(state.chatId, -21012);
    assert.equal(state.selected.has(6), true);
    assert.equal(state.selected.has(0), true);
    assert.equal(state.selected.size, 2);
  }
});

test('round-trips a timeslot_times/list and /add state', () => {
  const userId = 21013;
  setScheduleEditState(userId, { flow: 'timeslot_times', step: 'list', chatId: -21013, times: ['10:00'] });

  let state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'timeslot_times' && state.step === 'list');

  setScheduleEditState(userId, { flow: 'timeslot_times', step: 'add', chatId: -21013, times: ['10:00'] });
  state = getScheduleEditState(userId);
  assert.ok(state?.flow === 'timeslot_times' && state.step === 'add');
  if (state?.flow === 'timeslot_times' && state.step === 'add') {
    assert.deepEqual(state.times, ['10:00']);
  }
});
