const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Pisyk LeadPilot API running' });
});

// ── SCRAPE: Real Google Places data ──────────────────────────
app.post('/api/scrape', async (req, res) => {
  const { query, city, limit = 10 } = req.body;
  if (!query || !city) return res.status(400).json({ error: 'query and city required' });
  if (!PLACES_KEY) return res.status(500).json({ error: 'GOOGLE_PLACES_API_KEY not set' });

  try {
    const searchRes = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      { params: { query: `${query} in ${city}`, key: PLACES_KEY } }
    );

    const results = searchRes.data.results.slice(0, parseInt(limit));

    const detailed = await Promise.all(
      results.map(async (place) => {
        try {
          const detailRes = await axios.get(
            'https://maps.googleapis.com/maps/api/place/details/json',
            {
              params: {
                place_id: place.place_id,
                fields: 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,opening_hours,types',
                key: PLACES_KEY,
              },
            }
          );
          const d = detailRes.data.result;
          return {
            place_id: place.place_id,
            name: d.name,
            address: d.formatted_address,
            phone: d.formatted_phone_number || null,
            website: d.website || null,
            rating: d.rating || null,
            reviews: d.user_ratings_total || 0,
            hours: d.opening_hours?.weekday_text?.[0] || null,
            type: (d.types || [])[0]?.replace(/_/g, ' ') || query,
            city,
            instagram: null,
            onDelivery: false,
            googleProfile: !!(d.rating && d.user_ratings_total > 0),
            modernSite: null,
            hasOrdering: false,
            audited: false,
            score: 0,
            emailStatus: null,
            emailSubject: '',
            emailBody: '',
            pitches: [],
          };
        } catch {
          return null;
        }
      })
    );

    res.json({ leads: detailed.filter(Boolean) });
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    console.error('Scrape error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── AUDIT: AI prospect scoring ────────────────────────────────
app.post('/api/audit', async (req, res) => {
  const { lead } = req.body;
  if (!lead) return res.status(400).json({ error: 'lead required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const prompt = `You are auditing a local business as a cold outreach sales prospect for Pisyk, a digital agency in Atlanta that builds websites, ordering systems, and digital tools for small businesses.

Business: ${lead.name}
Type: ${lead.type}
Location: ${lead.address}
Phone: ${lead.phone || 'unknown'}
Website: ${lead.website || 'none'}
Rating: ${lead.rating} (${lead.reviews} reviews)
Instagram: ${lead.instagram || 'none'}
On delivery apps: ${lead.onDelivery}
Google profile complete: ${lead.googleProfile}
Modern website: ${lead.modernSite}
Online ordering: ${lead.hasOrdering}

Scoring rules — add points where each applies:
- No website: +3
- Bad or outdated website: +2
- Incomplete Google Business profile: +2
- On DoorDash or Uber Eats (paying commissions): +3
- Fewer than 20 reviews: +1
- Active on Instagram but no way to order or book online: +2
- Phone-only contact, no email or online form: +1

Estimate which apply from the info above. Return ONLY valid JSON, no markdown:
{
  "score": <number 0-14>,
  "modernSite": <true|false|null>,
  "hasOrdering": <true|false>,
  "onDelivery": <true|false>,
  "instagram": "<handle or null>",
  "googleProfile": <true|false>,
  "pitches": ["<specific one-sentence pitch angle>","<pitch 2>","<pitch 3>"],
  "scoreBreakdown": "<2 sentences explaining the score>"
}`;

  try {
    const aiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );
    const text = aiRes.data.content.map(c => c.text || '').join('');
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (err) {
    console.error('Audit error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── EMAIL: AI cold email generator ───────────────────────────
app.post('/api/email', async (req, res) => {
  const { lead, settings = {} } = req.body;
  if (!lead) return res.status(400).json({ error: 'lead required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const company = settings.company || 'Pisyk';
  const email = settings.email || 'hello@pisyk.co';
  const website = settings.website || 'www.pisyk.com';
  const name = settings.name || '';

  const prompt = `Write a cold outreach email to a local restaurant or small business owner on behalf of ${company}, a digital agency that builds websites and direct ordering systems.

Rules:
- Open with Hi [Restaurant Name] using the actual business name
- Be conversational and specific, no fluff
- Do NOT mention DoorDash, Uber Eats, or Grubhub by name. Say "third party platform" or "online ordering platform"
- Lead with a specific observation about their business, not a compliment
- Mention the cost in both monthly AND yearly terms
- No dashes anywhere in the email
- End by directing them to ${website} to learn more, then ask them to reply
- No phone call CTA
- Sign off as ${name ? name + '\n' + company : company}
- Include email: ${email} and website: ${website} in signature

Business: ${lead.name} (${lead.type})
Location: ${lead.address}
Pain points: ${(lead.pitches || []).join('; ') || 'digital presence gaps'}
Prospect score: ${lead.score}/14

Return ONLY valid JSON, no markdown:
{"subject":"<subject line>","body":"<full email body, use \\n for line breaks>"}`;

  try {
    const aiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );
    const text = aiRes.data.content.map(c => c.text || '').join('');
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (err) {
    console.error('Email error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Pisyk LeadPilot API running on port ${PORT}`));
