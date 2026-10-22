/**
 * Classifies where a visit came from without storing the full referrer URL.
 * Only a coarse source label, hostname and campaign fields are persisted.
 */

const SEARCH_ENGINES = [
  [/^google\./i, 'Google'],
  [/^bing\./i, 'Bing'],
  [/^duckduckgo\./i, 'DuckDuckGo'],
  [/^search\.brave\./i, 'Brave Search'],
  [/^startpage\./i, 'Startpage'],
  [/^qwant\./i, 'Qwant'],
  [/^ecosia\./i, 'Ecosia'],
  [/^yahoo\./i, 'Yahoo'],
  [/^yandex\./i, 'Yandex'],
  [/^baidu\./i, 'Baidu'],
  [/^naver\./i, 'Naver'],
];

const SOCIAL = [
  [/^(www\.)?(twitter|x)\.com$/i, 'X'],
  [/^t\.co$/i, 'X'],
  [/^(www\.)?linkedin\.com$/i, 'LinkedIn'],
  [/^(www\.)?lnkd\.in$/i, 'LinkedIn'],
  [/^(www\.)?facebook\.com$/i, 'Facebook'],
  [/^(l|lm|m)\.facebook\.com$/i, 'Facebook'],
  [/^(www\.)?instagram\.com$/i, 'Instagram'],
  [/^(www\.)?reddit\.com$/i, 'Reddit'],
  [/^(www\.)?news\.ycombinator\.com$/i, 'Hacker News'],
  [/^(www\.)?youtube\.com$/i, 'YouTube'],
  [/^(www\.)?producthunt\.com$/i, 'Product Hunt'],
  [/^(www\.)?github\.com$/i, 'GitHub'],
  [/^(www\.)?pinterest\./i, 'Pinterest'],
  [/^(www\.)?threads\.net$/i, 'Threads'],
  [/^(www\.)?mastodon\./i, 'Mastodon'],
  [/^(www\.)?tiktok\.com$/i, 'TikTok'],
  [/^(www\.)?discord\.(com|gg)$/i, 'Discord'],
  [/^(www\.)?news\.google\.com$/i, 'Google News'],
];

function hostnameOf(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function cleanCampaign(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 64);
}

export function classifyReferrer(rawReferrer, { siteDomain = '', utm = null } = {}) {
  const campaign = utm && typeof utm === 'object' ? utm : {};
  const utmSource = cleanCampaign(campaign.source);
  const utmMedium = cleanCampaign(campaign.medium);
  const utmCampaign = cleanCampaign(campaign.name);

  if (utmSource) {
    return {
      source: utmSource,
      domain: null,
      medium: utmMedium || 'campaign',
      campaign: utmCampaign || null,
    };
  }

  const host = typeof rawReferrer === 'string' ? hostnameOf(rawReferrer) : null;
  const ownDomain = String(siteDomain || '').toLowerCase().replace(/^www\./, '');

  if (!host || (ownDomain && (host === ownDomain || host.endsWith(`.${ownDomain}`)))) {
    return { source: 'Direct', domain: null, medium: 'direct', campaign: utmCampaign || null };
  }

  for (const [re, label] of SEARCH_ENGINES) {
    if (re.test(host)) return { source: label, domain: host, medium: 'search', campaign: utmCampaign || null };
  }
  for (const [re, label] of SOCIAL) {
    if (re.test(host)) return { source: label, domain: host, medium: 'social', campaign: utmCampaign || null };
  }

  return { source: host, domain: host, medium: 'referral', campaign: utmCampaign || null };
}
