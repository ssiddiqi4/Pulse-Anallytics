/*!
 * Pulse Analytics tracker v1
 * Cookie-free, no dependencies, ~3 KB gzipped. Safe to load with `defer`.
 *
 * <script defer src="https://stats.example.com/t.js" data-site="demo"></script>
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var attr = function (name, fallback) {
    var value = script.getAttribute(name);
    return value === null ? fallback : value;
  };

  var site = attr('data-site', '');
  if (!site) {
    if (window.console) console.warn('[pulse] missing data-site on the tracking script');
    return;
  }

  var src = script.src || '';
  var endpoint = attr('data-endpoint', src.replace(/\/t\.js(?:\?.*)?$/, '')).replace(/\/+$/, '');
  var dev = attr('data-dev', 'false') === 'true';
  var host = location.hostname;
  if (!dev && (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || /\.local$/.test(host))) {
    return;
  }

  var respectDnt = attr('data-respect-dnt', 'true') !== 'false';
  var trackOutbound = attr('data-outbound', 'true') !== 'false';
  var exclude = attr('data-exclude', '')
    .split(',')
    .map(function (value) { return value.trim(); })
    .filter(Boolean);

  function hasPrivacySignal() {
    return (
      navigator.doNotTrack === '1' ||
      window.doNotTrack === '1' ||
      navigator.msDoNotTrack === '1' ||
      navigator.globalPrivacyControl === true
    );
  }

  if (respectDnt && hasPrivacySignal()) return;

  var disabled = false;
  try {
    if (localStorage.getItem('_pulse_optout') === '1') disabled = true;
  } catch (err) { /* storage can be unavailable */ }

  var now = function () { return Date.now(); };
  var SESSION_KEY = '_pulse_sid';
  var TOUCH_KEY = '_pulse_ts';
  var SESSION_IDLE_MS = 30 * 60 * 1000;

  function randomId(length) {
    var bytes = new Uint8Array(length);
    var cryptoObj = window.crypto || window.msCrypto;
    if (cryptoObj && cryptoObj.getRandomValues) {
      cryptoObj.getRandomValues(bytes);
    } else {
      for (var i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = '';
    for (var j = 0; j < length; j += 1) out += (bytes[j] % 36).toString(36);
    return out;
  }

  function sessionId() {
    var sid = null;
    var last = 0;
    try {
      sid = sessionStorage.getItem(SESSION_KEY);
      last = Number(sessionStorage.getItem(TOUCH_KEY) || 0);
    } catch (err) { /* private mode */ }
    if (!sid || !/^[A-Za-z0-9_-]{8,40}$/.test(sid) || now() - last > SESSION_IDLE_MS) {
      sid = randomId(16);
    }
    try {
      sessionStorage.setItem(SESSION_KEY, sid);
      sessionStorage.setItem(TOUCH_KEY, String(now()));
    } catch (err) { /* private mode */ }
    return sid;
  }

  function touchSession() {
    try { sessionStorage.setItem(TOUCH_KEY, String(now())); } catch (err) { /* ignore */ }
  }

  function currentPath() {
    var path = location.pathname || '/';
    return path.length > 300 ? path.slice(0, 300) : path;
  }

  function pageTitle() {
    return (document.title || '').slice(0, 120);
  }

  function utmParams() {
    try {
      var params = new URLSearchParams(location.search);
      var out = {
        source: (params.get('utm_source') || '').trim().slice(0, 64),
        medium: (params.get('utm_medium') || '').trim().slice(0, 64),
        name: (params.get('utm_campaign') || '').trim().slice(0, 64),
      };
      return out.source || out.medium || out.name ? out : null;
    } catch (err) {
      return null;
    }
  }

  function sanitizeProps(props) {
    if (!props || typeof props !== 'object') return null;
    var out = {};
    var count = 0;
    var keys = Object.keys(props);
    for (var i = 0; i < keys.length && count < 10; i += 1) {
      var key = keys[i];
      var value = props[key];
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) continue;
      if (typeof value === 'string') out[key] = value.slice(0, 120);
      else if (typeof value === 'number' && isFinite(value)) out[key] = value;
      else if (typeof value === 'boolean') out[key] = value;
      else continue;
      count += 1;
    }
    return count ? out : null;
  }

  function excluded(path) {
    for (var i = 0; i < exclude.length; i += 1) {
      var pattern = exclude[i];
      if (!pattern) continue;
      if (pattern.indexOf('*') !== -1) {
        var re = new RegExp('^' + pattern.split('*').map(function (part) {
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('.*') + '$');
        if (re.test(path)) return true;
      } else if (path === pattern || path.indexOf(pattern) === 0) {
        return true;
      }
    }
    return false;
  }

  function transmit(payload) {
    if (disabled) return;
    if (respectDnt && hasPrivacySignal()) return;
    touchSession();
    try {
      var json = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        // text/plain keeps this a CORS-simple request: no preflight round-trip.
        var blob = new Blob([json], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(endpoint + '/api/v1/event', blob)) return;
      }
      if (window.fetch) {
        fetch(endpoint + '/api/v1/event', {
          method: 'POST',
          body: json,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          mode: 'cors',
          credentials: 'omit',
          keepalive: true,
        }).catch(function () { /* fail silently */ });
      }
    } catch (err) { /* analytics must never break the page */ }
  }

  var current = null;
  var lastPath = null;

  function finishPage() {
    if (!current) return;
    var elapsed = now() - current.start;
    if (elapsed >= 1000) {
      transmit({
        v: 1,
        site: site,
        type: 'duration',
        sid: sessionId(),
        p: current.path,
        pv: current.pv,
        d: Math.min(elapsed, 30 * 60 * 1000),
      });
    }
    current.start = now();
  }

  function sendPageview() {
    var path = currentPath();
    finishPage();
    var pv = randomId(12);
    current = { pv: pv, path: path, start: now() };
    lastPath = path;

    transmit({
      v: 1,
      site: site,
      type: 'pageview',
      sid: sessionId(),
      pv: pv,
      p: path,
      t: pageTitle(),
      r: document.referrer || null,
      u: utmParams(),
      l: navigator.language || null,
      tz: (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (err) { return null; }
      })(),
      screen: { w: window.innerWidth || 0, h: window.innerHeight || 0 },
    });
  }

  function onRouteChange() {
    if (excluded(currentPath())) return;
    if (currentPath() === lastPath && current) return;
    sendPageview();
  }

  function start() {
    if (excluded(currentPath())) return;
    sendPageview();

    if (trackOutbound) {
      document.addEventListener('click', function (event) {
        var node = event.target;
        while (node && node.tagName !== 'A') node = node.parentNode;
        if (!node || !node.getAttribute) return;
        var href = node.getAttribute('href');
        if (!href) return;
        var url;
        try { url = new URL(href, location.href); } catch (err) { return; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        var isDownload = node.hasAttribute('download');
        if (url.hostname === location.hostname && !isDownload) return;
        transmit({
          v: 1,
          site: site,
          type: 'outbound',
          sid: sessionId(),
          p: currentPath(),
          url: url.href.slice(0, 240),
        });
      }, true);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        finishPage();
      } else if (current) {
        current.start = now();
      }
    });
    window.addEventListener('pagehide', finishPage);

    if ('pushState' in history) {
      ['pushState', 'replaceState'].forEach(function (method) {
        var original = history[method];
        if (typeof original !== 'function') return;
        history[method] = function () {
          var result = original.apply(this, arguments);
          setTimeout(onRouteChange, 0);
          return result;
        };
      });
    }
    window.addEventListener('popstate', function () { setTimeout(onRouteChange, 0); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  var api = window.pulse || {};
  api.track = function (name, props) {
    if (!name || typeof name !== 'string') return;
    transmit({
      v: 1,
      site: site,
      type: 'event',
      sid: sessionId(),
      p: currentPath(),
      name: name.slice(0, 64),
      props: sanitizeProps(props),
    });
  };
  api.pageview = onRouteChange;
  api.optOut = function () {
    disabled = true;
    try { localStorage.setItem('_pulse_optout', '1'); } catch (err) { /* ignore */ }
  };
  api.optIn = function () {
    disabled = false;
    try { localStorage.removeItem('_pulse_optout'); } catch (err) { /* ignore */ }
  };
  window.pulse = api;
})();
