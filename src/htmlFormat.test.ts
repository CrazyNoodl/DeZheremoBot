import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, placeLink } from './htmlFormat.js';

test('escapeHtml escapes & individually', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('escapeHtml escapes < individually', () => {
  assert.equal(escapeHtml('a < b'), 'a &lt; b');
});

test('escapeHtml escapes > individually', () => {
  assert.equal(escapeHtml('a > b'), 'a &gt; b');
});

test('escapeHtml escapes " individually', () => {
  assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
});

test('escapeHtml escapes all four special characters together in one string', () => {
  assert.equal(
    escapeHtml('<b>"Tom" & Jerry</b>'),
    '&lt;b&gt;&quot;Tom&quot; &amp; Jerry&lt;/b&gt;',
  );
});

test('escapeHtml leaves ordinary Cyrillic/Ukrainian text and emoji untouched', () => {
  assert.equal(escapeHtml('Привіт, друже! 🍽️😀'), 'Привіт, друже! 🍽️😀');
});

test('escapeHtml returns empty string for empty string', () => {
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml does not recursively re-escape already-escaped entities (single pass, & escaped first)', () => {
  // If & were escaped and then the result were re-scanned, '&lt;' would become '&amp;lt;' twice
  // over or otherwise mangle it further. A correct single-pass replace turns the literal
  // characters '&', 'l', 't', ';' into '&amp;lt;' exactly once.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('placeLink renders an Instagram URL (with www.) as a link with the extracted username as label', () => {
  assert.equal(
    placeLink('https://www.instagram.com/milkbarkyiv'),
    '<a href="https://www.instagram.com/milkbarkyiv">milkbarkyiv</a>',
  );
});

test('placeLink extracts the username from an Instagram URL without www.', () => {
  assert.equal(
    placeLink('https://instagram.com/milkbarkyiv'),
    '<a href="https://instagram.com/milkbarkyiv">milkbarkyiv</a>',
  );
});

test('placeLink extracts just the username from an Instagram URL with a trailing slash', () => {
  assert.equal(
    placeLink('https://www.instagram.com/milkbarkyiv/'),
    '<a href="https://www.instagram.com/milkbarkyiv/">milkbarkyiv</a>',
  );
});

test('placeLink extracts just the username from an Instagram URL with a query string, not the query string itself', () => {
  assert.equal(
    placeLink('https://www.instagram.com/milkbarkyiv?igsh=abc123'),
    '<a href="https://www.instagram.com/milkbarkyiv?igsh=abc123">milkbarkyiv</a>',
  );
});

test('placeLink renders a non-Instagram link (expz.menu) with the generic "заклад" label', () => {
  assert.equal(
    placeLink('https://expz.menu/11111111-1111-1111-1111-111111111111'),
    '<a href="https://expz.menu/11111111-1111-1111-1111-111111111111">заклад</a>',
  );
});

test('placeLink renders a non-Instagram link (maps.app.goo.gl) with the generic "заклад" label', () => {
  assert.equal(
    placeLink('https://maps.app.goo.gl/AbCdEf12345'),
    '<a href="https://maps.app.goo.gl/AbCdEf12345">заклад</a>',
  );
});

test('placeLink escapes a " smuggled in via the permissive trailing query string so it cannot break out of the href attribute', () => {
  const malicious = 'https://expz.menu/11111111-1111-1111-1111-111111111111?x="><script>alert(1)</script>';
  const result = placeLink(malicious);

  // The href value itself must have the quote escaped, not raw.
  const hrefMatch = result.match(/^<a href="([^]*?)">.*<\/a>$/);
  assert.ok(hrefMatch, `expected result to match the <a href="...">label</a> shape, got: ${result}`);
  const hrefValue = hrefMatch[1];

  assert.ok(!hrefValue.includes('"'), `href value should not contain a raw unescaped quote: ${hrefValue}`);
  assert.ok(hrefValue.includes('&quot;'), `href value should contain the escaped quote: ${hrefValue}`);
});
