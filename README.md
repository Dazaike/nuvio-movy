# nuvio-movy

Nuvio plugin for [movy.sx](https://www.movy.sx/). Add the raw `manifest.json` URL in Nuvio under Settings > Media > Plugins.

The first stream is `Movy - Auto (Best)` (ranked by resolution, then English audio, then subtitles). Every other working server follows it.

## How it works

1. `GET https://api.wecollege.net/seed?mediaId=<tmdbId>` returns `{seed, ttlMs}`.
2. `GET https://api.wecollege.net/<server>/sources?title&mediaType&year&episodeId&seasonId&tmdbId&imdbId&enc=2&seed=<seed>` returns an encrypted payload.
   The payload is base64url, XORed with a keystream derived from `seed` and the TMDB id, with the magic bytes `mvm1`. `providers/movy.js` ports the site's own decoder.
3. Title, year and IMDb id come from the site's TMDB proxy `https://db.wecollege.net/3`.

Every request needs only `Referer: https://www.movy.sx/`. Stream URLs need the same header (the plugin returns it in `headers`).

## Test

`node test/run.js 550 movie` and `node test/run.js 1396 tv 1 1` fetch the streams and download the first media segment of each one.
