import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addSubmission, clearSubmissions, getSubmission, listSubmissions } from './store.js';

test('addSubmission then getSubmission round-trips', () => {
  addSubmission(-1001, 1, 'artem', 'Дежерьома');

  // node:sqlite rows come back as null-prototype objects — spread into a plain object before
  // comparing, since deepEqual from node:assert/strict is an alias for deepStrictEqual and checks
  // prototypes too.
  assert.deepEqual({ ...getSubmission(-1001, 1) }, { userId: 1, username: 'artem', place: 'Дежерьома' });
});

test('addSubmission overwrites the same user\'s previous place in that chat', () => {
  addSubmission(-1002, 1, 'artem', 'First');
  addSubmission(-1002, 1, 'artem', 'Second');

  assert.equal(getSubmission(-1002, 1)?.place, 'Second');
  assert.equal(listSubmissions(-1002).length, 1);
});

test('submissions are isolated per chat', () => {
  addSubmission(-1003, 1, 'artem', 'Chat A place');
  addSubmission(-1004, 1, 'artem', 'Chat B place');

  assert.equal(getSubmission(-1003, 1)?.place, 'Chat A place');
  assert.equal(getSubmission(-1004, 1)?.place, 'Chat B place');
});

test('clearSubmissions only removes the given chat', () => {
  addSubmission(-1005, 1, 'artem', 'A');
  addSubmission(-1005, 2, 'olya', 'B');
  addSubmission(-1006, 1, 'artem', 'C');

  clearSubmissions(-1005);

  assert.deepEqual(listSubmissions(-1005), []);
  assert.equal(listSubmissions(-1006).length, 1);
});

test('getSubmission returns undefined for an unknown user', () => {
  assert.equal(getSubmission(-1007, 999), undefined);
});
