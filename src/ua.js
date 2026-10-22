/**
 * Minimal user-agent classification. We only keep coarse dimensions
 * (browser / OS / device class) and never persist the raw UA string.
 */

const BOT_RE = new RegExp(
  [
    'bot\\b', 'crawler', 'spider', 'crawling', 'slurp', 'scraper', 'scraping',
    'headlesschrome', 'headless firefox', 'phantomjs', 'lighthouse', 'pagespeed',
    'pingdom', 'uptime', 'monitor', 'gtmetrix', 'statuscake', 'better uptime',
    'curl/', 'wget/', 'python-requests', 'python-urllib', 'go-http-client',
    'java/', 'okhttp', 'axios/', 'node-fetch', 'undici', 'insomnia',
    'postman', 'httpie', 'facebookexternalhit', 'embedly', 'slackbot',
    'discordbot', 'telegrambot', 'whatsapp', 'preview', 'vercel-screenshot',
    'netlify', 'google-inspectiontool', 'chrome-lighthouse', 'ahrefs', 'semrush',
    'mj12bot', 'dotbot', 'petalbot', 'bytespider', 'amazonbot', 'applebot',
    'gptbot', 'chatgpt-user', 'claudebot', 'perplexitybot', 'ccbot', 'anthropic',
  ].join('|'),
  'i',
);

function major(ua, re) {
  const m = ua.match(re);
  return m ? `${m[1]}` : null;
}

export function parseUA(userAgent = '') {
  const ua = String(userAgent);
  const bot = !ua.trim() || BOT_RE.test(ua);

  let os = 'Other';
  if (/Windows NT 10|Windows NT 11/i.test(ua)) os = 'Windows';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Other';
  let version = null;
  if (/Edg(?:e|A|iOS)?\//i.test(ua)) {
    browser = 'Edge';
    version = major(ua, /Edg(?:e|A|iOS)?\/(\d+)/i);
  } else if (/OPR\/|Opera/i.test(ua)) {
    browser = 'Opera';
    version = major(ua, /(?:OPR|Opera)\/(\d+)/i);
  } else if (/SamsungBrowser\//i.test(ua)) {
    browser = 'Samsung Internet';
    version = major(ua, /SamsungBrowser\/(\d+)/i);
  } else if (/Firefox\/|FxiOS\//i.test(ua)) {
    browser = 'Firefox';
    version = major(ua, /(?:Firefox|FxiOS)\/(\d+)/i);
  } else if (/Chrome\/|CriOS\//i.test(ua)) {
    browser = 'Chrome';
    version = major(ua, /(?:Chrome|CriOS)\/(\d+)/i);
  } else if (/Safari\//i.test(ua)) {
    browser = 'Safari';
    version = major(ua, /Version\/(\d+)/i);
  }

  let device = 'desktop';
  if (bot) device = 'bot';
  else if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) device = 'mobile';

  return { bot, browser, version, os, device };
}
