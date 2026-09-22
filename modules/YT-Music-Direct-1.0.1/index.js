(() => {
  'use strict';

  const MODULE_NAME = 'SynthetiqYTMusicDirectV101';
  const INNERTUBE_URL = 'https://music.youtube.com/youtubei/v1/search';
  const CLIENT_NAME = 'WEB_REMIX';
  const CLIENT_VERSION = '1.20260916.01.00';

  const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  function ok(data) {
    return { ok: true, data: JSON.stringify(data) };
  }

  function fail(message) {
    return { ok: false, error: { message: text(message) || 'YouTube Music connector error' } };
  }

  function getConfig() {
    try { return globalThis.SYNTHETIQ_CONFIG || {}; } catch (_) { return {}; }
  }

  function makeBody(query) {
    return {
      context: {
        client: {
          clientName: CLIENT_NAME,
          clientVersion: CLIENT_VERSION,
          hl: 'en',
          gl: 'US'
        }
      },
      query: text(query)
    };
  }

  async function postJson(url, body) {
    let response;
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    if (typeof fetchv2 === 'function') {
      response = await fetchv2(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } else {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    let data;
    try {
      if (response && typeof response.json === 'function') data = await response.json();
      else if (response && typeof response.text === 'function') data = JSON.parse(await response.text());
      else data = JSON.parse(String(response && response.body || ''));
    } catch (_) {
      throw new Error('YouTube Music returned invalid JSON');
    }

    if (!data) throw new Error('YouTube Music returned an empty response');
    if (data.error) {
      const message = data.error.message || 'YouTube Music request failed';
      throw new Error(message);
    }
    return data;
  }

  function endpoint() {
    const c = getConfig();
    const key = c.youtubeMusicApiKey || c.YTMUSIC_API_KEY || c.youtubeApiKey || c.YOUTUBE_API_KEY;
    const url = new URL(INNERTUBE_URL);
    if (key) url.searchParams.set('key', String(key));
    url.searchParams.set('prettyPrint', 'false');
    return url.toString();
  }

  function firstRunText(runs) {
    return text((runs || []).map(x => x && x.text || '').join(''));
  }

  function thumb(renderer) {
    const thumbs = renderer && renderer.thumbnail && renderer.thumbnail.thumbnails;
    return thumbs && thumbs.length ? thumbs[thumbs.length - 1].url || '' : '';
  }

  function durationToSeconds(value) {
    const s = text(value);
    if (!s) return 0;
    const p = s.split(':').map(Number);
    if (p.some(Number.isNaN)) return 0;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return p[0] || 0;
  }

  function parseSong(renderer) {
    const id = text(renderer && renderer.videoId);
    if (!id) return null;

    const flex = renderer.flexColumns || [];
    const title = firstRunText(
      flex[0] && flex[0].musicResponsiveListItemFlexColumnRenderer &&
      flex[0].musicResponsiveListItemFlexColumnRenderer.text && 
      flex[0].musicResponsiveListItemFlexColumnRenderer.text.runs
    );

    const second = firstRunText(
      flex[1] && flex[1].musicResponsiveListItemFlexColumnRenderer &&
      flex[1].musicResponsiveListItemFlexColumnRenderer.text &&
      flex[1].musicResponsiveListItemFlexColumnRenderer.text.runs
    );

    const fixed = renderer.fixedColumns && renderer.fixedColumns[0] &&
      renderer.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer;
    const duration = firstRunText(fixed && fixed.text && fixed.text.runs);

    return {
      id: 'ytm:' + id,
      title: title || 'Unknown Title',
      artist: second || 'Unknown Artist',
      album: '',
      artwork: thumb(renderer),
      durationSeconds: durationToSeconds(duration),
      source: 'youtube-music',
      videoId: id,
      videoUrl: 'https://music.youtube.com/watch?v=' + encodeURIComponent(id),
      playbackType: 'youtube-music'
    };
  }

  function collectSongs(node, out) {
    if (!node || typeof node !== 'object') return;

    if (node.musicResponsiveListItemRenderer) {
      const item = parseSong(node.musicResponsiveListItemRenderer);
      if (item) out.push(item);
      return;
    }

    if (Array.isArray(node)) {
      for (const child of node) collectSongs(child, out);
      return;
    }

    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === 'object') collectSongs(child, out);
    }
  }

  async function search(query) {
    const q = text(typeof query === 'object' ? (query.query || query.q || '') : query);
    if (!q) return [];

    const data = await postJson(endpoint(), makeBody(q));
    const rows = [];
    collectSongs(data, rows);

    const seen = new Set();
    return rows.filter(row => {
      if (seen.has(row.videoId)) return false;
      seen.add(row.videoId);
      return true;
    }).slice(0, 25);
  }

  async function searchResults(query) {
    try {
      return ok(await search(query));
    } catch (e) {
      return fail(e && e.message ? e.message : e);
    }
  }

  async function homeSections() {
    try {
      const queries = [
        ['Popular Music', 'popular songs'],
        ['New Music', 'new music'],
        ['album', 'album']
      ];
      const sections = [];

      for (const [title, query] of queries) {
        try {
          const items = await search(query);
          if (items.length) sections.push({ title, type: 'track', items: items.slice(0, 12) });
        } catch (_) {}
      }

      return ok(sections);
    } catch (e) {
      return fail(e && e.message ? e.message : e);
    }
  }

  function normalizeId(value) {
    const s = text(typeof value === 'object'
      ? (value.id || value.videoId || '')
      : value).replace(/^ytm:/i, '').replace(/^yt:/i, '');

    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;

    try {
      const u = new URL(s);
      if (u.hostname.includes('youtube.com')) return u.searchParams.get('v') || '';
      if (u.hostname === 'youtu.be') return u.pathname.replace(/^\/+/, '').slice(0, 11);
    } catch (_) {}

    return '';
  }

  async function extractDetails(item) {
    try {
      const id = normalizeId(item);
      if (!id) throw new Error('Invalid YouTube Music video ID');

      return ok({
        id: 'ytm:' + id,
        title: text(item && item.title) || '',
        artist: text(item && item.artist) || '',
        album: text(item && item.album) || '',
        artwork: text(item && item.artwork) || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'),
        durationSeconds: Number(item && item.durationSeconds) || 0,
        source: 'youtube-music',
        videoId: id,
        videoUrl: 'https://music.youtube.com/watch?v=' + encodeURIComponent(id),
        playbackType: 'youtube-music'
      });
    } catch (e) {
      return fail(e && e.message ? e.message : e);
    }
  }

  async function extractTracks(item) {
    try {
      if (Array.isArray(item)) return ok(item.filter(Boolean));
      return ok(item ? [item] : []);
    } catch (e) {
      return fail(e && e.message ? e.message : e);
    }
  }

  async function extractAudioUrl(item) {
    try {
      const id = normalizeId(item);
      if (!id) throw new Error('Invalid YouTube Music video ID');

      /*
       * YouTube Music's InnerTube search endpoint supplies catalogue metadata,
       * not a stable public raw-audio URL. Do not fabricate or scrape a media
       * URL here. The connector returns the canonical player route so the host
       * app can apply its own supported playback policy.
       */
      return ok({
        url: 'https://music.youtube.com/watch?v=' + encodeURIComponent(id),
        playbackUrl: 'https://music.youtube.com/watch?v=' + encodeURIComponent(id),
        videoId: id,
        title: text(item && item.title) || '',
        artist: text(item && item.artist) || '',
        album: text(item && item.album) || '',
        artwork: text(item && item.artwork) || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'),
        durationSeconds: Number(item && item.durationSeconds) || 0,
        source: 'youtube-music',
        playbackType: 'youtube-music',
        directAudio: false
      });
    } catch (e) {
      return fail(e && e.message ? e.message : e);
    }
  }

  const api = { searchResults, homeSections, extractDetails, extractTracks, extractAudioUrl };
  globalThis[MODULE_NAME] = api;
  globalThis.searchResults = searchResults;
  globalThis.homeSections = homeSections;
  globalThis.extractDetails = extractDetails;
  globalThis.extractTracks = extractTracks;
  globalThis.extractAudioUrl = extractAudioUrl;
})();
