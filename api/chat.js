export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { message, systemPrompt } = req.body || {};
  if (!message) return res.status(400).json({ error: 'missing message' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system: systemPrompt || 'You are a customer at a Japanese yatai food stall. Respond in Japanese, keep it short and natural (1-2 sentences).',
        messages: [{ role: 'user', content: message }],
      }),
    });
    const data = await r.json();
    const reply = data?.content?.[0]?.text || '…';
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
