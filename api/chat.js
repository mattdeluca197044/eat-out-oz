// api/chat.js — Vercel serverless function
//
// Add this file to your backend project (the one at eat-out-oz.vercel.app),
// alongside your other /api routes like generate-description.js. It expects
// the same ANTHROPIC_API_KEY environment variable you already set up for
// the "Generate for me" description feature — no new secrets needed.
//
// Request body: { mode: 'diner' | 'owner', message: string, history: [...], context: {...} }
// Response: { reply: string }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { mode, message, history = [], context } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  // Basic guardrails — keep the request small and bounded regardless of
  // what the client sends.
  const trimmedMessage = message.slice(0, 1000);
  const trimmedHistory = Array.isArray(history)
    ? history.slice(-10).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : [];

  let systemPrompt;

  if (mode === 'owner') {
    // TODO: If you want to be strict about it, verify the Authorization
    // header here the same way your other authenticated endpoints do
    // (e.g. your existing verifyToken/JWT check) before trusting that the
    // `context` the client sent actually belongs to that restaurant. Right
    // now this endpoint trusts whatever context the frontend sends — fine
    // for a first version, but worth tightening once this gets real usage.
    systemPrompt = `You are a helpful assistant inside the outtoeat restaurant partner portal. You help restaurant owners understand their listing, bookings, and stats, and answer questions about how the portal works.

Here is this restaurant's current data:
${JSON.stringify(context)}

Be concise and specific, using the data above where relevant. If asked about something you don't have data for (e.g. billing details, payment methods), say you're not sure and suggest they contact support rather than guessing.`;
  } else {
    // Diner-facing assistant on the public outtoeat site.
    systemPrompt = `You are outtoeat's dining assistant, helping people find a restaurant, café, or takeaway spot in Sydney.

Here are the current listings you can recommend from:
${JSON.stringify(context)}

Only recommend places from this list — never invent a restaurant that isn't in it. If nothing in the list fits what they're asking for, say so honestly rather than making something up. Keep replies short, warm, and conversational — a couple of sentences, not a formatted report.`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: [...trimmedHistory, { role: 'user', content: trimmedMessage }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(502).json({ error: 'The assistant is temporarily unavailable — please try again shortly.' });
    }

    const reply = data.content?.find(block => block.type === 'text')?.text
      || "Sorry, I didn't quite catch that — could you rephrase?";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Chat handler error:', err);
    return res.status(500).json({ error: 'Something went wrong on our end.' });
  }
}
