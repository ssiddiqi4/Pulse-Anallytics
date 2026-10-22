import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUA } from '../src/ua.js';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const SAFARI_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

test('detects desktop Chrome on Windows', () => {
  assert.deepEqual(parseUA(CHROME_WINDOWS), {
    bot: false,
    browser: 'Chrome',
    version: '124',
    os: 'Windows',
    device: 'desktop',
  });
});

test('detects Edge even though its UA also contains Chrome', () => {
  const ua = `${CHROME_WINDOWS} Edg/124.0.2478.67`;
  const parsed = parseUA(ua);
  assert.equal(parsed.browser, 'Edge');
  assert.equal(parsed.os, 'Windows');
  assert.equal(parsed.device, 'desktop');
});

test('detects iPhone Safari as mobile', () => {
  const parsed = parseUA(SAFARI_IPHONE);
  assert.equal(parsed.browser, 'Safari');
  assert.equal(parsed.os, 'iOS');
  assert.equal(parsed.device, 'mobile');
  assert.equal(parsed.bot, false);
});

test('detects iPad as tablet', () => {
  const parsed = parseUA(SAFARI_IPAD);
  assert.equal(parsed.device, 'tablet');
  assert.equal(parsed.os, 'iOS');
});

test('detects Android tablet vs phone', () => {
  const tablet = 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const phone = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(parseUA(tablet).device, 'tablet');
  assert.equal(parseUA(phone).device, 'mobile');
  assert.equal(parseUA(phone).os, 'Android');
});

test('flags crawlers and empty agents as bots', () => {
  assert.equal(parseUA('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').bot, true);
  assert.equal(parseUA('curl/8.5.0').bot, true);
  assert.equal(parseUA('').bot, true);
  assert.equal(parseUA('Mozilla/5.0 HeadlessChrome/120.0.0.0').bot, true);
});

test('does not flag normal browsers as bots', () => {
  assert.equal(parseUA(CHROME_WINDOWS).bot, false);
  assert.equal(parseUA(SAFARI_IPHONE).bot, false);
});
