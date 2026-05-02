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

  const company  = settings.company  || 'Pisyk';
  const sigName  = settings.name     || 'Moustapha Diop';
  const sigEmail = settings.email    || 'moustapha@pisyk.com';
  const sigPhone = settings.phone    || '(404) 919-5364';
  const website  = settings.website  || 'www.pisyk.com';
  const address  = settings.address  || '20 Terminus Place Northeast, Atlanta, GA 30305';
  const monthly  = settings.monthly  || 2835;
  const yearly   = settings.yearly   || 34020;

  // Build specific pain points from actual business data
  const painPoints = [];
  if (!lead.website)                          painPoints.push('no website — completely invisible to online searches');
  if (lead.website && lead.modernSite===false) painPoints.push('has a website but it is outdated and likely not mobile friendly');
  if (lead.onDelivery)                        painPoints.push(`listed on a third party ordering platform paying ~$${monthly.toLocaleString()}/month ($${yearly.toLocaleString()}/year) in commission`);
  if (!lead.hasOrdering && lead.website)      painPoints.push('has a website but no way to order or book online directly');
  if (lead.instagram && !lead.hasOrdering)    painPoints.push('active on Instagram but no way for followers to actually order or book');
  if ((lead.reviews || 0) < 20)              painPoints.push(`only ${lead.reviews || 0} Google reviews — very low online credibility`);
  if (!lead.googleProfile)                    painPoints.push('incomplete or missing Google Business profile');
  if (!lead.phone && !lead.email)             painPoints.push('no easy way for customers to contact them');

  const prompt = `You are writing a cold outreach email on behalf of ${sigName}, Business Development Lead at ${company}, a digital agency in Atlanta that builds websites, ordering systems, booking platforms, and automation tools for small businesses.

BUSINESS YOU ARE WRITING TO:
- Name: ${lead.name}
- Type: ${lead.type || 'local business'}
- Location: ${lead.city || lead.address || 'unknown'}
- Phone: ${lead.phone || 'not listed'}
- Website: ${lead.website || 'NONE'}
- Email found: ${lead.email || 'none'}
- Google rating: ${lead.rating || 'unknown'} (${lead.reviews || 0} reviews)
- Instagram: ${lead.instagram ? '@' + lead.instagram : 'none found'}
- On delivery apps paying commission: ${lead.onDelivery ? 'YES' : 'No'}
- Has online ordering: ${lead.hasOrdering ? 'Yes' : 'NO'}
- Modern website: ${lead.modernSite === true ? 'Yes' : lead.modernSite === false ? 'NO — outdated' : 'unknown'}
- Google profile complete: ${lead.googleProfile ? 'Yes' : 'NO'}
- Prospect score: ${lead.score}/14
- Score explanation: ${lead.scoreBreakdown || 'not yet audited'}
- Specific pain points identified: ${painPoints.length > 0 ? painPoints.join('; ') : 'general digital presence gaps'}
- AI pitch angles: ${(lead.pitches || []).join(' | ') || 'none generated yet'}

COMMISSION NUMBERS (use these if on delivery apps):
- Monthly loss: $${monthly.toLocaleString()}
- Yearly loss: $${yearly.toLocaleString()}

EMAIL RULES — follow all of these exactly:
1. Open with: Hi ${lead.name},
2. Lead with ONE very specific observation about THIS business (not generic — use the actual data above)
3. Name the exact pain point most relevant to them — reference specific details like their review count, the fact they have no website, or the delivery platform cost
4. Explain what Pisyk does to fix that specific problem — be concrete, not vague
5. Mention both monthly AND yearly costs if they are on delivery apps
6. Do NOT mention DoorDash, Uber Eats, or Grubhub by name — say "third party platform" or "ordering platform"
7. No dashes anywhere in the email body
8. End by directing them to ${website} and asking them to reply — no phone call CTA
9. Keep it under 250 words — tight and specific beats long and generic
10. No fluff, no "I hope this finds you well", no hollow compliments

SIGNATURE — end every email with exactly this:
${sigName}
Business Development Lead
Growth & Partnerships | ${company}
${sigPhone}
${sigEmail}
${website}
${address}

Return ONLY valid JSON, no markdown fences:
{"subject":"<compelling subject line that references something specific about this business>","body":"<full email body using \\n for line breaks>"}`;

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
    console.error('Email error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});




const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Pisyk LeadPilot API on port ${PORT}`));
