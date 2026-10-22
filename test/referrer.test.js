import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyReferrer } from '../src/referrer.js';

test('treats missing and self referrers as direct', () => {
  assert.deepEqual(classifyReferrer(null, { siteDomain: 'acme.example' }), {
    source: 'Direct',
    domain: null,
    medium: 'direct',
    campaign: null,
  });
  assert.equal(
    classifyReferrer('https://acme.example/pricing', { siteDomain: 'acme.example' }).source,
    'Direct',
  );
  assert.equal(
    classifyReferrer('https://docs.acme.example/start', { siteDomain: 'acme.example' }).source,
    'Direct',
  );
});

test('recognizes search engines across country domains', () => {
  const result = classifyReferrer('https://www.google.co.uk/search?q=pulse', {
    siteDomain: 'acme.example',
  });
  assert.equal(result.source, 'Google');
  assert.equal(result.medium, 'search');
  assert.equal(result.domain, 'google.co.uk');

  assert.equal(
    classifyReferrer('https://duckduckgo.com/?q=analytics', { siteDomain: 'acme.example' }).source,
    'DuckDuckGo',
  );
});

test('recognizes social networks and referrals', () => {
  assert.equal(
    classifyReferrer('https://x.com/acme/status/123', { siteDomain: 'acme.example' }).source,
    'X',
  );
  assert.equal(
    classifyReferrer('https://www.linkedin.com/feed/', { siteDomain: 'acme.example' }).source,
    'LinkedIn',
  );
  const github = classifyReferrer('https://github.com/acme/pulse', { siteDomain: 'acme.example' });
  assert.equal(github.source, 'GitHub');
  assert.equal(github.medium, 'social');
});

test('utm parameters win over the referrer', () => {
  const result = classifyReferrer('https://google.com/search?q=x', {
    siteDomain: 'acme.example',
    utm: { source: 'newsletter', medium: 'email', name: 'launch' },
  });
  assert.deepEqual(result, {
    source: 'newsletter',
    domain: null,
    medium: 'email',
    campaign: 'launch',
  });
});

test('rejects malformed referrers without throwing', () => {
  assert.equal(classifyReferrer('not a url', { siteDomain: 'acme.example' }).source, 'Direct');
  assert.equal(classifyReferrer('javascript:alert(1)', { siteDomain: 'acme.example' }).source, 'Direct');
});
