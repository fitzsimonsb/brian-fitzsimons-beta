// Vercel serverless function — POST /api/food-scan
// Takes a base64 JPEG data URL from the Food Scanner demo, sends it to Claude
// (vision) for a short nutritional estimate, and returns { summary }.
//
// Requires ANTHROPIC_API_KEY to be set as an environment variable on the
// Vercel project (Project Settings -> Environment Variables). The key never
// reaches the browser — this function is the only thing that reads it.

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // fast + inexpensive, supports vision
const MAX_BASE64_LEN = 6_000_000; // ~4.5MB decoded, keeps us under Vercel's request body limit

// ---- simple per-IP rate limit ----
// In-memory, so it only holds the line within one warm serverless instance — it resets
// on a cold start and isn't shared across concurrent instances/regions. That means it's
// not a hard guarantee, but for a personal portfolio demo it's enough to stop a casual
// bot or script from hammering (and billing) this endpoint. If this ever needs a real
// guarantee under higher traffic, swap this Map for Vercel KV or Upstash Redis.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 6; // requests per window per IP — a curious visitor trying a few
                            // meals is fine; a script looping the endpoint is not.
const MAX_TRACKED_IPS = 5000; // memory safety valve so this can't grow unbounded

const hits = new Map(); // ip -> { count, windowStart }

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
    if (hits.size > MAX_TRACKED_IPS) {
      hits.delete(hits.keys().next().value); // evict the oldest tracked IP
    }
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
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const ip = getClientIp(req);
  const { limited, retryAfterSec } = checkRateLimit(ip);
  if (limited) {
    const mins = Math.ceil(retryAfterSec / 60);
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: `Too many scans from this connection — try again in about ${mins} minute${mins === 1 ? '' : 's'}.` });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server not configured — ANTHROPIC_API_KEY is missing.' });
    return;
  }

  try {
    const image = req.body && req.body.image;
    if (!image || typeof image !== 'string') {
      res.status(400).json({ error: 'No image provided.' });
      return;
    }

    const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: 'Malformed image data.' });
      return;
    }
    const mediaType = match[1];
    const base64Data = match[2];

    if (base64Data.length > MAX_BASE64_LEN) {
      res.status(413).json({ error: 'Image too large.' });
      return;
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64Data }
              },
              {
                type: 'text',
                text: 'You are a nutrition estimator for a personal portfolio demo. Identify the food in this photo and give a short, friendly one-paragraph estimate of calories, protein, carbs, and fat. Keep it under 60 words total. If no food is visible, say so plainly instead of guessing. End with a short "estimate only" note.'
              }
            ]
          }
        ]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error('Anthropic API error', anthropicRes.status, errText);
      // Surface the real reason (status + Anthropic's own message) instead of a generic
      // string — none of this can contain the API key, so it's safe to show the visitor,
      // and it means a misconfigured key/model/billing issue is diagnosable from the
      // demo itself rather than needing a trip into Vercel's function logs.
      let detail = '';
      try {
        const parsed = JSON.parse(errText);
        detail = (parsed && parsed.error && parsed.error.message) || '';
      } catch (e) {
        detail = errText.slice(0, 200);
      }
      res.status(502).json({
        error: `Vision analysis failed (${anthropicRes.status}${detail ? ': ' + detail : ''})`
      });
      return;
    }

    const data = await anthropicRes.json();
    const summary = (data.content || []).find((b) => b.type === 'text');
    res.status(200).json({ summary: summary ? summary.text : 'No description returned.' });
  } catch (err) {
    console.error('food-scan error', err);
    res.status(500).json({ error: 'Something went wrong analyzing the image.' });
  }
};
