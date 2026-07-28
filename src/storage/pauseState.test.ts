import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPaused, pause, resume } from './pauseState.js';

test('a chat is not paused until pause() is called', () => {
  assert.equal(isPaused(-4001), false);
  pause(-4001);
  assert.equal(isPaused(-4001), true);
});

test('resume() reverses pause()', () => {
  pause(-4002);
  resume(-4002);
  assert.equal(isPaused(-4002), false);
});

test('pause state is isolated per chat', () => {
  pause(-4003);
  assert.equal(isPaused(-4004), false);
});

test('pause() is idempotent — calling it twice does not throw', () => {
  pause(-4005);
  assert.doesNotThrow(() => pause(-4005));
  assert.equal(isPaused(-4005), true);
});

test('resume() on a chat that was never paused does not throw', () => {
  assert.doesNotThrow(() => resume(-4006));
});
