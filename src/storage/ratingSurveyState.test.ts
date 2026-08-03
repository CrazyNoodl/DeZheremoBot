import assert from 'node:assert/strict';
import { test } from 'node:test';
import { disableRatingSurvey, enableRatingSurvey, isRatingSurveyEnabled } from './ratingSurveyState.js';

test('a chat is enabled by default, before disableRatingSurvey is ever called', () => {
  assert.equal(isRatingSurveyEnabled(-4101), true);
});

test('disableRatingSurvey flips a chat to disabled', () => {
  disableRatingSurvey(-4102);
  assert.equal(isRatingSurveyEnabled(-4102), false);
});

test('enableRatingSurvey reverses disableRatingSurvey', () => {
  disableRatingSurvey(-4103);
  enableRatingSurvey(-4103);
  assert.equal(isRatingSurveyEnabled(-4103), true);
});

test('disabled state is isolated per chat', () => {
  disableRatingSurvey(-4104);
  assert.equal(isRatingSurveyEnabled(-4105), true);
});

test('disableRatingSurvey is idempotent — calling it twice does not throw', () => {
  disableRatingSurvey(-4106);
  assert.doesNotThrow(() => disableRatingSurvey(-4106));
  assert.equal(isRatingSurveyEnabled(-4106), false);
});

test('enableRatingSurvey on a chat that was never disabled does not throw', () => {
  assert.doesNotThrow(() => enableRatingSurvey(-4107));
  assert.equal(isRatingSurveyEnabled(-4107), true);
});
