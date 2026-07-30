import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearDeclinedPlace, clearDeclinedPlacesForChat, getDeclinedPlace, rememberDeclinedPlace } from './declinedPlace.js';

test('a user has no remembered declined place until rememberDeclinedPlace() is called', () => {
  assert.equal(getDeclinedPlace(-6001, 1), undefined);
});

test('rememberDeclinedPlace() then getDeclinedPlace() round-trips the place', () => {
  rememberDeclinedPlace(-6002, 1, 'https://www.instagram.com/somewhere');
  assert.equal(getDeclinedPlace(-6002, 1), 'https://www.instagram.com/somewhere');
});

test('rememberDeclinedPlace() again for the same (chat, user) overwrites the previous value', () => {
  rememberDeclinedPlace(-6003, 1, 'A');
  rememberDeclinedPlace(-6003, 1, 'B');
  assert.equal(getDeclinedPlace(-6003, 1), 'B');
});

test('remembered places are isolated per chat', () => {
  rememberDeclinedPlace(-6004, 1, 'A');
  assert.equal(getDeclinedPlace(-6005, 1), undefined);
});

test('remembered places are isolated per user within the same chat', () => {
  rememberDeclinedPlace(-6006, 1, 'A');
  assert.equal(getDeclinedPlace(-6006, 2), undefined);
});

test('clearDeclinedPlace() removes only that (chat, user) entry', () => {
  rememberDeclinedPlace(-6007, 1, 'A');
  rememberDeclinedPlace(-6007, 2, 'B');

  clearDeclinedPlace(-6007, 1);

  assert.equal(getDeclinedPlace(-6007, 1), undefined);
  assert.equal(getDeclinedPlace(-6007, 2), 'B');
});

test('clearDeclinedPlace() on an entry that was never set does not throw', () => {
  assert.doesNotThrow(() => clearDeclinedPlace(-6008, 1));
});

test('clearDeclinedPlacesForChat() removes every user\'s entry for that chat, leaving other chats untouched', () => {
  rememberDeclinedPlace(-6009, 1, 'A');
  rememberDeclinedPlace(-6009, 2, 'B');
  rememberDeclinedPlace(-6010, 1, 'C');

  clearDeclinedPlacesForChat(-6009);

  assert.equal(getDeclinedPlace(-6009, 1), undefined);
  assert.equal(getDeclinedPlace(-6009, 2), undefined);
  assert.equal(getDeclinedPlace(-6010, 1), 'C');
});
