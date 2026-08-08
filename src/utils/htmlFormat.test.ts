import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, placeLabel, placeLabelWithHint, placeLink, placeLinkWithHint } from './htmlFormat.js';

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

test('placeLabel extracts the Instagram username, plain (no HTML), for use as a button label', () => {
  assert.equal(placeLabel('https://www.instagram.com/milkbarkyiv'), 'milkbarkyiv');
});

test('placeLabel returns the generic "заклад" label for a non-Instagram link', () => {
  assert.equal(placeLabel('https://maps.app.goo.gl/AbCdEf12345'), 'заклад');
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

test('placeLabelWithHint leaves an Instagram username untouched (already unambiguous, no hint needed)', () => {
  assert.equal(placeLabelWithHint('https://www.instagram.com/milkbarkyiv'), 'milkbarkyiv');
});

test('placeLabelWithHint appends a short tail of the URL to the generic "заклад" fallback', () => {
  assert.equal(placeLabelWithHint('https://expz.menu/11111111-1111-1111-1111-1111111111aa'), 'заклад (…11aa)');
});

test('placeLabelWithHint gives two different generic-fallback places distinct hints', () => {
  const a = placeLabelWithHint('https://expz.menu/11111111-1111-1111-1111-1111111111aa');
  const b = placeLabelWithHint('https://expz.menu/22222222-2222-2222-2222-2222222222bb');
  assert.notEqual(a, b);
});

test('placeLabelWithHint strips a trailing query string before taking the hint tail, not the tracking param', () => {
  assert.equal(
    placeLabelWithHint('https://expz.menu/11111111-1111-1111-1111-1111111111aa?utm=abcdefgh'),
    'заклад (…11aa)',
  );
});

test('placeLabelWithHint strips a trailing slash before taking the hint tail', () => {
  assert.equal(placeLabelWithHint('https://maps.app.goo.gl/AbCdEf12345/'), 'заклад (…2345)');
});

test('placeLinkWithHint renders the generic fallback as a clickable link labeled with the hint', () => {
  assert.equal(
    placeLinkWithHint('https://expz.menu/11111111-1111-1111-1111-1111111111aa'),
    '<a href="https://expz.menu/11111111-1111-1111-1111-1111111111aa">заклад (…11aa)</a>',
  );
});

test('placeLinkWithHint renders an Instagram link exactly like placeLink (no hint)', () => {
  assert.equal(
    placeLinkWithHint('https://www.instagram.com/milkbarkyiv'),
    placeLink('https://www.instagram.com/milkbarkyiv'),
  );
});
