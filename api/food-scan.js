// Vercel serverless function — POST /api/food-scan
// Takes a base64 JPEG data URL from the Food Scanner demo, sends it to Claude
// (vision) for a short nutritional estimate, and returns { summary }.
//
// Requires ANTHROPIC_API_KEY to be set as an environment variable on the
// Vercel project (Project Settings -> Environment Variables). The key never
// reaches the browser — this function is the only thing that reads it.

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // fast + inexpensive, supports vision
const MAX_BASE64_LEN = 6_000_000; // ~4.5MB decoded, keeps us under Vercel's request body limit

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
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
      res.status(502).json({ error: 'Vision analysis failed — try again in a moment.' });
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
