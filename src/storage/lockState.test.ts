import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocked, lock, unlock } from './lockState.js';

test('a chat is unlocked until lock() is called', () => {
  assert.equal(isLocked(-2001), false);
  lock(-2001);
  assert.equal(isLocked(-2001), true);
});

test('unlock() reverses lock()', () => {
  lock(-2002);
  unlock(-2002);
  assert.equal(isLocked(-2002), false);
});

test('lock state is isolated per chat', () => {
  lock(-2003);
  assert.equal(isLocked(-2004), false);
});

test('lock() is idempotent — calling it twice does not throw', () => {
  lock(-2005);
  assert.doesNotThrow(() => lock(-2005));
  assert.equal(isLocked(-2005), true);
});

test('unlock() on a chat that was never locked does not throw', () => {
  assert.doesNotThrow(() => unlock(-2006));
});
