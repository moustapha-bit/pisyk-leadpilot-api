const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const OUTSCRAPER_KEY = process.env.OUTSCRAPER_API_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Pisyk LeadPilot API running' });
});

// ── SCRAPE: Outscraper Google Maps (includes emails) ──────────────────────────
app.post('/api/scrape', async (req, res) => {
  const { query, city, limit = 50 } = req.body;
  if (!query || !city) return res.status(400).json({ error: 'query and city required' });
  if (!OUTSCRAPER_KEY) return res.status(500).json({ error: 'OUTSCRAPER_API_KEY not set' });

  try {
    const response = await axios.get('https://api.app.outscraper.com/maps/search-v3', {
      headers: { 'X-API-KEY': OUTSCRAPER_KEY },
      params: {
        query: `${query} in ${city}`,
        limit: parseInt(limit),
        language: 'en',
        fields: 'name,full_address,phone,site,email,rating,reviews,working_hours,type,business_status',
        async: false,
      },
    });

    const raw = response.data?.data?.[0] || [];

    const leads = raw
      .filter(b => b.business_status !== 'CLOSED_PERMANENTLY')
      .map(b => ({
        name:          b.name || 'Unknown',
        address:       b.full_address || '',
        phone:         b.phone || null,
        website:       b.site || null,
        email:         b.email || null,
        rating:        b.rating || null,
        reviews:       b.reviews || 0,
        hours:         b.working_hours?.Monday || null,
        type:          b.type || query,
        city,
        instagram:     null,
        onDelivery:    false,
        googleProfile: !!(b.rating && b.reviews > 0),
        modernSite:    null,
        hasOrdering:   false,
        audited:       false,
        score:         0,
        emailStatus:   null,
        emailSubject:  '',
        emailBody:     '',
        pitches:       [],
        pipelineStage: 'prospect',
      }));

    res.json({ leads });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('Scrape error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── AUDIT: AI prospect scoring ────────────────────────────────────────────────
app.post('/api/audit', async (req, res) => {
  const { lead } = req.body;
  if (!lead) return res.status(400).json({ error: 'lead required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const prompt = `You are auditing a local business as a cold outreach prospect for Pisyk, a digital agency in Atlanta that builds websites, ordering systems, and digital tools for small businesses.

Business: ${lead.name}
Type: ${lead.type}
Location: ${lead.address}
Phone: ${lead.phone || 'unknown'}
Website: ${lead.website || 'none'}
Email: ${lead.email || 'none found'}
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
- On DoorDash or Uber Eats paying commissions: +3
- Fewer than 20 reviews: +1
- Active on Instagram but no way to order or book online: +2
- Phone-only contact no email or online form: +1

Return ONLY valid JSON no markdown:
{
  "score": <0-14>,
  "modernSite": <true|false|null>,
  "hasOrdering": <true|false>,
  "onDelivery": <true|false>,
  "instagram": "<handle or null>",
  "googleProfile": <true|false>,
  "pitches": ["<specific one-sentence pitch>","<pitch 2>","<pitch 3>"],
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

// ── EMAIL: AI cold email generator ────────────────────────────────────────────
app.post('/api/email', async (req, res) => {
  const { lead, settings = {} } = req.body;
  if (!lead) return res.status(400).json({ error: 'lead required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const company = settings.company || 'Pisyk';
  const email   = settings.email   || 'hello@pisyk.co';
  const website = settings.website || 'www.pisyk.com';
  const name    = settings.name    || '';

  const prompt = `Write a cold outreach email to a local business owner on behalf of ${company}, a digital agency that builds websites, ordering systems, and digital tools for small businesses.

Rules:
- Open with: Hi ${lead.name},
- Be conversational and specific, no fluff
- Do NOT mention DoorDash, Uber Eats, or Grubhub by name. Say "third party platform" or "ordering platform"
- Lead with a specific observation about their business
- Mention costs in both monthly AND yearly terms
- No dashes anywhere in the email
- End by directing them to ${website}
- Ask them to just reply. No phone call CTA
- Sign off as: ${name ? name + '\n' + company : company}\n${email}\n${website}

Business: ${lead.name} (${lead.type}) in ${lead.address}
Pain points identified: ${(lead.pitches || []).join('; ') || 'digital presence gaps'}
Prospect score: ${lead.score}/14

Return ONLY valid JSON no markdown:
{"subject":"<subject line>","body":"<full email body using \\n for line breaks>"}`;

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
app.listen(PORT, () => console.log(`Pisyk LeadPilot API on port ${PORT}`));
