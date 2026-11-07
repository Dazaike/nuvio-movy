// Movy (movy.sx) provider for Nuvio. Promise-based on purpose (no async/await).
//
// How movy.sx serves streams (reverse-engineered from its web bundle):
//   1. GET https://api.wecollege.net/seed?mediaId=<tmdbId>            -> {seed, ttlMs}
//   2. GET https://api.wecollege.net/<city>/sources?title&mediaType&year&episodeId&seasonId&tmdbId&imdbId&enc=2&seed=<seed>
//      -> text/plain: base64url(XOR(JSON, keystream(seed, tmdbId))) prefixed by the magic bytes "mvm1"
//   Every request only needs a `Referer: https://www.movy.sx/` header. The decrypt below is a port of the site's own code.
// Each <city> is an independent upstream scraper. Returns an "Auto (Best)" stream first, then every other source.

var SITE = 'https://www.movy.sx/';
var API = 'https://api.wecollege.net';
var META = 'https://db.wecollege.net/3';
var HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Referer': SITE,
  'Origin': 'https://www.movy.sx'
};
var STREAM_HEADERS = { 'Referer': SITE, 'Origin': 'https://www.movy.sx' };

// English / original-audio scrapers only (munich, berlin, paris, delhi, cancun are dubs and are not queried).
// bonus: reliability observed in testing (segments downloaded for every pick); dash: not HLS, ranked last.
var PROVIDERS = [
  { id: 'miami', label: 'Miami', bonus: 300 },
  { id: 'boise', label: 'Boise', bonus: 250, masterOnly: true }, // per-quality links are intermittently 502; the master carries every variant
  { id: 'reno', label: 'Reno', bonus: 150 },
  { id: 'oakland', label: 'Oakland', bonus: 150 },
  { id: 'vegas', label: 'Vegas', bonus: 120 },
  { id: 'phoenix', label: 'Phoenix', bonus: 100 },
  { id: 'atlanta', label: 'Atlanta', bonus: 100 },
  { id: 'chicago', label: 'Chicago', bonus: 0 },
  { id: 'seattle', label: 'Seattle', bonus: -250 }, // segments 404 for some titles
  { id: 'austin', label: 'Austin', bonus: -50, onlyQuality: 'English' },
  { id: 'dallas', label: 'Dallas', bonus: -100 },
  { id: 'portland', label: 'Portland', bonus: -200 }, // segments return 503 intermittently
  { id: 'nashville', label: 'Nashville', bonus: -1000, dash: true }
];
var REQUEST_TIMEOUT_MS = 8000;
var DEADLINE_MS = 2500; // max wait for the per-server lookups; late servers are dropped
var SHOW_ALL = true; // list every source after the Auto pick
var DEBUG = true;
function log() { if (DEBUG) console.log.apply(console, ['[Movy]'].concat([].slice.call(arguments))); }

// ---------- payload codec (port of the site's seed-keyed keystream) ----------
var MAGIC = [109, 118, 109, 49]; // "mvm1"
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function mix(e) {
  e = e >>> 0; e ^= e >>> 16; e = Math.imul(e, 0x85ebca6b) >>> 0;
  e ^= e >>> 13; e = Math.imul(e, 0xc2b2ae35) >>> 0;
  return (e ^ (e >>> 16)) >>> 0;
}
function rotl(e, a) {
  e = e >>> 0; a &= 31;
  return a === 0 ? e : ((e << a) | (e >>> (32 - a))) >>> 0;
}
function b64decode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
  var out = [], buf = 0, bits = 0;
  for (var i = 0; i < str.length; i++) {
    buf = (buf << 6) | B64.indexOf(str.charAt(i)); bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); buf &= (1 << bits) - 1; }
  }
  return out;
}
function utf8decode(bytes) {
  var s = '', i = 0;
  while (i < bytes.length) {
    var c = bytes[i++], cp;
    if (c < 0x80) cp = c;
    else if (c < 0xe0) cp = ((c & 31) << 6) | (bytes[i++] & 63);
    else if (c < 0xf0) cp = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else cp = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    if (cp > 0xffff) { cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
    else s += String.fromCharCode(cp);
  }
  return s;
}
function initState(seed, mediaId) {
  var fnv = 0x811c9dc5, t;
  for (t = 0; t < seed.length; t++) fnv = Math.imul(fnv ^ seed.charCodeAt(t), 0x1000193) >>> 0;
  var S = [], used = {};
  var n = mix((mix(fnv) ^ mix(((Number(mediaId) >>> 0) ^ 0x9e3779b9) >>> 0)) >>> 0) >>> 0;
  for (var e = 0; e < 8; e++) {
    var a = n % 61;
    n = rotl((n + 0x9e3779b9) >>> 0, 7 + (7 & e));
    S[a] = (n ^ mix(n)) >>> 0; used[a] = 1;
    n = mix((n + a) >>> 0);
  }
  return { S: S, used: used, acc: mix(0xa5a5a5a5 ^ n) >>> 0 };
}
function step(st, counter) {
  var l = st.acc, d = l % 61;
  var i = st.used[d] ? -1 : 0;
  var r = (st.S[d] || 0) >>> 0;
  var c = Math.imul(0x9e3779b9, counter + 1) >>> 0;
  var s = (r ^ c) >>> 0;
  var b = (((l ^ s) >>> 0) | ((l & s & i) >>> 0)) >>> 0;
  b = (rotl((b + l) >>> 0, 31 & d) ^ rotl(l, 31 & Math.imul(d, 7))) >>> 0;
  l = mix((b + 0x9e3779b9) >>> 0);
  st.S[d] = l >>> 0; st.used[d] = 1; st.acc = l;
  return l >>> 0;
}
// Returns the decrypted JSON text, or throws.
function decrypt(payload, seed, mediaId) {
  var data = b64decode(payload), st = initState(seed, mediaId), ks = [], counter = 0, k, j;
  while (ks.length < data.length) {
    k = step(st, counter++);
    ks.push(k & 255, (k >>> 8) & 255, (k >>> 16) & 255, (k >>> 24) & 255);
  }
  for (j = 0; j < data.length; j++) data[j] ^= ks[j];
  for (j = 0; j < MAGIC.length; j++) if (data[j] !== MAGIC[j]) throw new Error('decrypt failed: bad seed or payload');
  return utf8decode(data.slice(MAGIC.length));
}

// ---------- network ----------
// Bound a request so one hung upstream cannot keep the whole stream list on "Finding streams...".
function bound(promise, ms, fallback) {
  if (typeof setTimeout !== 'function') return promise;
  var timer;
  var guard = new Promise(function (resolve) { timer = setTimeout(function () { resolve(fallback); }, ms); });
  var done = function (v) { if (typeof clearTimeout === 'function') clearTimeout(timer); return v; };
  return Promise.race([promise, guard]).then(done, function (e) { done(); throw e; });
}

function okStatus(r) { return r.status >= 200 && r.status < 300; }

function getJson(url) {
  return bound(fetch(url, { headers: HEADERS })
    .then(function (r) { if (!okStatus(r)) throw new Error('HTTP ' + r.status); return r.json(); }), REQUEST_TIMEOUT_MS, null)
    .catch(function (e) { log('ERROR', url.slice(0, 80), String(e && e.message || e)); return null; });
}

// TMDB metadata via the site's own TMDB proxy: title/year (some scrapers search by title) and imdbId (several require it).
function loadMeta(tmdbId, isTv) {
  return getJson(META + '/' + (isTv ? 'tv' : 'movie') + '/' + encodeURIComponent(tmdbId) + '?append_to_response=external_ids')
    .then(function (m) {
      if (!m) return { title: '', year: '', imdbId: '' };
      var date = isTv ? m.first_air_date : m.release_date;
      return {
        title: (isTv ? m.name : m.title) || '',
        year: date ? String(date).slice(0, 4) : '',
        imdbId: m.imdb_id || (m.external_ids && m.external_ids.imdb_id) || '',
        seasons: m.number_of_seasons || ''
      };
    });
}

function getSeed(tmdbId) {
  return getJson(API + '/seed?mediaId=' + encodeURIComponent(tmdbId)).then(function (j) { return j && j.seed ? j.seed : null; });
}

function qs(params) {
  return Object.keys(params).filter(function (k) { return params[k] !== '' && params[k] != null; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}

function callProvider(p, params, seed, tmdbId) {
  var url = API + '/' + p.id + '/sources?' + qs(params) + '&enc=2&seed=' + encodeURIComponent(seed);
  return bound(fetch(url, { headers: HEADERS })
    .then(function (r) {
      if (!okStatus(r)) { log(p.id, 'HTTP', r.status); return null; }
      return r.text().then(function (t) {
        var data = JSON.parse(decrypt(String(t).replace(/^\s*"|"\s*$/g, ''), seed, tmdbId));
        log(p.id, 'sources', (data.sources || []).length, 'subs', (data.subtitles || []).length);
        return data;
      });
    }), REQUEST_TIMEOUT_MS, null)
    .catch(function (e) { log(p.id, 'ERROR', String(e && e.message || e)); return null; });
}

// ---------- ranking ----------
function heightOf(quality) {
  var q = String(quality || '');
  var m = /(\d{3,4})\s*p?/i.exec(q);
  if (m) return parseInt(m[1], 10);
  if (/4k|uhd/i.test(q)) return 2160;
  return 720; // "Auto" etc. = unknown, assume 720
}

function toCandidates(p, data) {
  if (!data) return [];
  var srcs = (data.sources || []).filter(function (s) { return s && s.url && (!p.onlyQuality || s.quality === p.onlyQuality); });
  var subs = (data.subtitles || []).filter(function (s) { return s && s.url && /english/i.test((s.language || '') + ' ' + (s.lang || '')); })
    .slice(0, 3).map(function (s) { return { url: s.url, label: s.language || s.lang || 'English', lang: 'en' }; });
  var list = srcs.map(function (s) { return { url: s.url, quality: String(s.quality || 'Auto'), height: heightOf(s.quality) }; });
  // Prefer dropping SD variants when the scraper also offers HD.
  if (list.some(function (c) { return c.height >= 720; })) list = list.filter(function (c) { return c.height >= 720; });
  if (p.masterOnly && data.playlist) list = [];
  if (data.playlist) list.unshift({ url: data.playlist, quality: 'Auto', height: 2160, master: true }); // adaptive master, up to 2160p
  return list.map(function (c) {
    return { url: c.url, quality: c.quality, height: c.height, master: !!c.master, provider: p, subs: subs };
  });
}

function score(c) {
  var s = c.height + c.provider.bonus;
  if (c.subs.length) s += 50;
  if (c.provider.dash) s -= 1000;
  return s;
}

function toStream(c, label) {
  var pl = c.provider.label;
  return {
    name: label || ('Movy - ' + pl),
    title: pl + ' - ' + (c.master ? 'Auto (up to ' + c.height + 'p)' : c.quality) + (c.subs.length ? ' | ' + c.subs.length + ' subs' : ''),
    description: 'Server: ' + pl + ' | ' + c.quality + ' | ' + (c.provider.dash ? 'DASH' : 'HLS') + ' | English/original audio',
    url: c.url,
    quality: c.master ? 'Auto' : c.quality,
    headers: STREAM_HEADERS,
    subtitles: c.subs
  };
}

function getStreams(tmdbId, mediaType, season, episode) {
  log('getStreams', tmdbId, mediaType, season, episode);
  var isTv = mediaType === 'tv';
  return Promise.all([loadMeta(tmdbId, isTv), getSeed(tmdbId)]).then(function (res) {
    var meta = res[0], seed = res[1];
    if (!seed) { log('no seed'); return []; }
    var params = {
      title: encodeURIComponent(meta.title), // the site double-encodes the title; keep identical
      mediaType: isTv ? 'tv' : 'movie',
      year: meta.year,
      totalSeasons: isTv ? meta.seasons : '',
      episodeId: isTv ? (episode || 1) : 1,
      seasonId: isTv ? (season || 1) : 1,
      tmdbId: tmdbId,
      imdbId: meta.imdbId
    };
    log('meta', meta.title, meta.year, meta.imdbId);
    var rest = new Array(PROVIDERS.length), t0 = Date.now();
    var jobs = PROVIDERS.map(function (p, i) {
      return callProvider(p, params, seed, tmdbId).then(function (d) { rest[i] = d; log(p.id, 'done', Date.now() - t0, 'ms'); });
    });
    // Return whatever has arrived by the deadline instead of waiting for the slowest server.
    return bound(Promise.all(jobs), DEADLINE_MS, null).then(function () {
      var seen = {}, all = [];
      PROVIDERS.forEach(function (p, i) {
        toCandidates(p, rest[i] || null).forEach(function (c) { if (!seen[c.url]) { seen[c.url] = 1; all.push(c); } });
      });
      log('deadline/all done after', Date.now() - t0, 'ms');
      all.sort(function (a, b) { return score(b) - score(a); });
      log('candidates', all.length);
      if (!all.length) return [];
      var best = all[0];
      log('best', best.provider.id, best.quality);
      var out = [toStream(best, 'Movy - Auto (Best)')];
      if (SHOW_ALL) all.forEach(function (c) { if (c !== best) out.push(toStream(c)); });
      return out;
    });
  }).catch(function (e) { log('FATAL', String(e && e.message || e)); return []; });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { getStreams: getStreams };
else global.getStreams = getStreams;
