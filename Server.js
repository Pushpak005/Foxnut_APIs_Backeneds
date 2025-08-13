// server.js
// Minimal API that returns best-matching healthy dishes from Swiggy/Zomato (Bengaluru)
// Uses Google Programmable Search (CSE) if KEY+CX provided; otherwise falls back to deep search links.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const CSE_KEY = process.env.CSE_API_KEY || '';
const CSE_ID  = process.env.CSE_ID || '';

// simple in-memory cache (per query) to avoid hitting the search API too often
const CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cacheGet(k) {
  const hit = CACHE.get(k);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) { CACHE.delete(k); return null; }
  return hit.v;
}
function cacheSet(k, v) { CACHE.set(k, { v, t: Date.now() }); }

// --- heuristics ---
const POSITIVE_TOKENS = [
  'salad','grilled','bowl','quinoa','sprouts','tofu','paneer','brown rice',
  'roasted','steamed','greens','lean','protein','soup','dal','millet'
];
const NEGATIVE_TOKENS = [
  'fried','butter','cream','creamy','cheese','biryani','burger','pizza','fries','sweet'
];

function scoreTitle(title, taste) {
  const t = title.toLowerCase();
  let s = 0, reasons = [];
  POSITIVE_TOKENS.forEach(k => { if (t.includes(k)) { s += 2; reasons.push(`has “${k}”`); } });
  NEGATIVE_TOKENS.forEach(k => { if (t.includes(k)) { s -= 2; reasons.push(`avoids “${k}”`); } });

  // taste preference nudges
  // tasty → allow items that mention "tikka", "peri peri", etc.
  if (taste === 'tasty' || taste === 'balanced') {
    ['tikka','peri','tangy','masala','grill'].forEach(k => { if (t.includes(k)) s += 1; });
  }
  if (taste === 'healthy') s += 1; // small nudge

  return { score: s, reasons };
}

function buildQueries(targetCalories, activity, taste) {
  // rough mapping to dish styles
  const base = (targetCalories <= 450)
    ? ['grilled salad', 'protein bowl', 'quinoa bowl', 'tofu salad', 'paneer salad']
    : ['high protein bowl', 'grilled chicken bowl', 'paneer bowl', 'tofu bowl', 'millet bowl'];

  const area = 'Bangalore';
  // add site filters in query text; CSE will still respect these
  const sites = ['site:swiggy.com', 'site:zomato.com'];
  const tasteBoost = (taste === 'tasty') ? 'tasty' : (taste === 'healthy' ? 'healthy' : 'balanced');

  // combine to a list of final query strings
  const qs = [];
  for (const b of base) {
    for (const s of sites) {
      qs.push(`${b} ${tasteBoost} ${s} ${area}`);
    }
  }
  return qs;
}

async function cseSearch(q) {
  if (!CSE_KEY || !CSE_ID) return null; // signal fallback
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(CSE_KEY)}&cx=${encodeURIComponent(CSE_ID)}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CSE error: ${res.status}`);
  const json = await res.json();
  if (!json.items) return [];
  return json.items
    .filter(it => /swiggy\.com|zomato\.com/i.test(it.link || ''))
    .map(it => ({
      title: it.title,
      link: it.link,
      snippet: it.snippet || ''
    }));
}

app.get('/', (_req, res) => res.json({ ok: true }));

app.get('/recommend', async (req, res) => {
  try {
    const calories = Number(req.query.calories || 500);
    const activity = String(req.query.activity || 'moderate'); // light | moderate | high
    const taste    = String(req.query.taste || 'balanced');   // healthy | tasty | balanced

    const targetMeal = Math.max(300, Math.min(800, Math.round(calories))); // clamp
    const queries = buildQueries(targetMeal, activity, taste);
    const cacheKey = JSON.stringify({ targetMeal, activity, taste });

    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    let results = [];
    if (CSE_KEY && CSE_ID) {
      // use CSE and merge results from several queries
      for (const q of queries.slice(0, 6)) { // limit to keep it snappy
        try {
          // eslint-disable-next-line no-await-in-loop
          const items = await cseSearch(q);
          results.push(...items);
        } catch (e) { /* ignore individual query failures */ }
      }
    }

    // Fallback if no API keys or no results: give smart deep-search links per dish label
    if (!CSE_KEY || !CSE_ID || results.length === 0) {
      const alt = queries.slice(0, 6).map(q => {
        const label = q.replace(/site:\S+/g,'').replace(/bangalore/i,'').trim();
        const google = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
        return {
          title: label,
          link: google,
          snippet: 'Open to see matching options on Swiggy/Zomato (Bengaluru).'
        };
      });
      const payload = {
        picks: alt.slice(0, 5).map(x => ({
          name: x.title,
          link: x.link,
          reason: `Matches your target ~${targetMeal} kcal and ${taste} preference.`,
          source: 'Heuristic v1 (fallback search links)'
        })),
        targetCalories: targetMeal,
        activity,
        taste,
        usedCSE: false
      };
      cacheSet(cacheKey, payload);
      return res.json(payload);
    }

    // Deduplicate by link
    const seen = new Set();
    results = results.filter(x => {
      if (seen.has(x.link)) return false;
      seen.add(x.link);
      return true;
    });

    // Score & sort
    const scored = results.map(r => {
      const { score, reasons } = scoreTitle(r.title, taste);
      return {
        name: r.title,
        link: r.link,
        snippet: r.snippet,
        score,
        reasons
      };
    }).sort((a,b) => b.score - a.score);

    const top = scored.slice(0, 5).map(x => ({
      name: x.name,
      link: x.link,
      reason: `Chosen for: ${x.reasons.slice(0,3).join(', ') || 'overall balance'}; target ~${targetMeal} kcal.`,
      source: `Heuristic v1 + ${activity} activity`
    }));

    const payload = {
      picks: top,
      targetCalories: targetMeal,
      activity,
      taste,
      usedCSE: true
    };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message || 'failed' });
  }
});

app.listen(PORT, () => console.log(`recommender running on :${PORT}`));
