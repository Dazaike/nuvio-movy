// Offline test harness: node test/run.js <tmdbId> <movie|tv> [season] [episode]
// For every returned stream: master playlist -> best variant -> first media segment, and require real media bytes.
// (Verification lives here on purpose; the plugin itself never makes verification requests.)
var mod = require('../providers/movy.js');
var args = process.argv.slice(2);
var tmdb = args[0] || '550', type = args[1] || 'movie', season = Number(args[2]) || undefined, episode = Number(args[3]) || undefined;
var H = { 'User-Agent': 'Mozilla/5.0 Chrome/130' };

function get(url, headers, bin) {
  return fetch(url, { headers: Object.assign({}, H, headers), redirect: 'follow', signal: AbortSignal.timeout(25000) }).then(function (r) {
    return (bin ? r.arrayBuffer().then(function (b) { return Buffer.from(b); }) : r.text()).then(function (body) { return { s: r.status, u: r.url, body: body }; });
  });
}
function kind(b) {
  if (!b.length) return 'empty';
  if (b[0] === 0x47) return 'ts';
  var s = b.slice(0, 64).toString('latin1');
  if (/ftyp|moof|styp/.test(s)) return 'fmp4';
  if (b[0] === 0x1a && b[1] === 0x45) return 'webm';
  if (s.charAt(0) === '<') return 'HTML';
  return 'unknown:' + b.slice(0, 6).toString('hex');
}
function check(st) {
  var h = st.headers || {};
  if (/dash/i.test(st.description)) {
    return get(st.url, h).then(function (p) { return { ok: p.s === 200 && /<MPD/.test(p.body), note: 'dash mpd ' + p.s }; });
  }
  return get(st.url, h).then(function (p) {
    if (p.s !== 200 || !/#EXTM3U/.test(p.body)) return { ok: false, note: 'playlist ' + p.s + ' ' + String(p.body).slice(0, 40).replace(/\s+/g, ' ') };
    var next = Promise.resolve(p);
    if (/#EXT-X-STREAM-INF/.test(p.body)) {
      var lines = p.body.split('\n').map(function (l) { return l.trim(); }), best = null, bw = -1;
      lines.forEach(function (l, i) {
        if (l.indexOf('#EXT-X-STREAM-INF') === 0) {
          var m = /BANDWIDTH=(\d+)/.exec(l), b = m ? +m[1] : 0;
          if (lines[i + 1] && b >= bw) { bw = b; best = lines[i + 1]; }
        }
      });
      // check the lowest-bandwidth-first is irrelevant; check the best variant
      next = get(new URL(best, p.u).href, h);
    }
    return next.then(function (v) {
      if (v.s !== 200 || !/#EXTM3U/.test(v.body)) return { ok: false, note: 'variant ' + v.s };
      var seg = v.body.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && l[0] !== '#'; })[0];
      if (!seg) return { ok: false, note: 'no segments' };
      return get(new URL(seg, v.u).href, h, true).then(function (s) {
        var k = kind(s.body);
        return { ok: s.s === 200 && s.body.length > 20000 && k !== 'HTML' && k.indexOf('unknown') !== 0, note: 'seg ' + s.s + ' ' + (s.body.length / 1048576).toFixed(2) + 'MB ' + k };
      });
    });
  }).catch(function (e) { return { ok: false, note: 'ERR ' + e.message }; });
}

var t0 = Date.now();
mod.getStreams(tmdb, type, season, episode).then(function (streams) {
  console.log('\n' + streams.length + ' streams in ' + (Date.now() - t0) + 'ms');
  return Promise.all(streams.map(check)).then(function (res) {
    streams.forEach(function (st, i) {
      console.log((res[i].ok ? 'OK  ' : 'BAD ') + st.name + ' | ' + st.title + ' | ' + st.quality + ' | ' + res[i].note);
    });
  });
});
