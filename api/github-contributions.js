// Vercel serverless function — GET /api/github-contributions
// Returns { user, days: [{ date: 'YYYY-MM-DD', level: 0-4 }, ...] } for the site's
// custom-styled (red/black) contribution graph.
//
// GitHub doesn't expose contribution counts via a public REST endpoint — the real
// data only comes from the GraphQL API with a personal access token. Instead, this
// parses the same lightweight HTML fragment GitHub's own profile page renders at
// github.com/users/<user>/contributions, server-side, so no token is needed and
// nothing is exposed to the browser.

const GH_USER = 'bfitzx';
const CACHE_SECONDS = 3600; // 1 hour — contribution data doesn't need to be live-live

// ---- simple per-IP rate limit (same pattern/rationale as api/food-scan.js) ----
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 30; // generous — this is a cheap scrape-and-cache, not an LLM call
const MAX_TRACKED_IPS = 5000;
const hits = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    if (hits.size > MAX_TRACKED_IPS) hits.delete(hits.keys().next().value);
    return { limited: false };
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { limited: true, retryAfterSec };
  }
  return { limited: false };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const ip = getClientIp(req);
  const { limited, retryAfterSec } = checkRateLimit(ip);
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: 'Too many requests — try again shortly.' });
    return;
  }

  try {
    const upstream = await fetch(`https://github.com/users/${GH_USER}/contributions`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; bfitzx-site-contrib-widget/1.0)' }
    });

    if (!upstream.ok) {
      res.status(502).json({ error: `GitHub returned ${upstream.status}` });
      return;
    }

    const html = await upstream.text();

    // GitHub's markup order for these two attributes hasn't been fully stable across
    // redesigns, so match both orders rather than assuming one.
    const days = [];
    const reDateFirst = /data-date="(\d{4}-\d{2}-\d{2})"[^>]*?data-level="(\d)"/g;
    const reLevelFirst = /data-level="(\d)"[^>]*?data-date="(\d{4}-\d{2}-\d{2})"/g;

    let m;
    while ((m = reDateFirst.exec(html))) days.push({ date: m[1], level: Number(m[2]) });
    if (!days.length) {
      while ((m = reLevelFirst.exec(html))) days.push({ date: m[2], level: Number(m[1]) });
    }

    if (!days.length) {
      res.status(502).json({ error: 'Could not parse contribution data.' });
      return;
    }

    res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}, stale-while-revalidate=86400`);
    res.status(200).json({ user: GH_USER, days });
  } catch (err) {
    console.error('github-contributions error', err);
    res.status(500).json({ error: 'Something went wrong fetching GitHub activity.' });
  }
};
