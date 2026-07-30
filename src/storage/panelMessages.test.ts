import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPanelMessageStore, type PanelMessageRef } from './panelMessages.js';

test('two stores created by separate calls are independently isolated', () => {
  const storeA = createPanelMessageStore<PanelMessageRef>();
  const storeB = createPanelMessageStore<PanelMessageRef>();

  storeA.set(1001, { chatId: 2001, messageId: 3001 });

  assert.equal(storeB.get(1001), undefined);
});

test('get returns undefined for a userId never set', () => {
  const store = createPanelMessageStore<PanelMessageRef>();

  assert.equal(store.get(1002), undefined);
});

test('set then get round-trips the exact ref back', () => {
  const store = createPanelMessageStore<PanelMessageRef>();
  const ref: PanelMessageRef = { chatId: 2002, messageId: 3002 };

  store.set(1003, ref);

  assert.deepEqual(store.get(1003), ref);
});

test('set for the same userId a second time overwrites the previous ref', () => {
  const store = createPanelMessageStore<PanelMessageRef>();

  store.set(1004, { chatId: 2004, messageId: 3004 });
  store.set(1004, { chatId: 2005, messageId: 3005 });

  assert.deepEqual(store.get(1004), { chatId: 2005, messageId: 3005 });
});

test('storage is isolated per userId within one store', () => {
  const store = createPanelMessageStore<PanelMessageRef>();

  store.set(1005, { chatId: 2006, messageId: 3006 });

  assert.equal(store.get(1006), undefined);
});

test('clear removes the entry so get returns undefined again', () => {
  const store = createPanelMessageStore<PanelMessageRef>();

  store.set(1007, { chatId: 2007, messageId: 3007 });
  store.clear(1007);

  assert.equal(store.get(1007), undefined);
});

test('clear on a userId that was never set does not throw', () => {
  const store = createPanelMessageStore<PanelMessageRef>();

  assert.doesNotThrow(() => store.clear(1008));
});

test('works with a wider ref shape than the base PanelMessageRef', () => {
  interface WideRef extends PanelMessageRef {
    groupChatId: number;
  }

  const store = createPanelMessageStore<WideRef>();
  const ref: WideRef = { chatId: 2008, messageId: 3008, groupChatId: -2008 };

  store.set(1009, ref);

  assert.deepEqual(store.get(1009), ref);
});
