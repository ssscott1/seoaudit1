// Zero-dependency analyzer — uses Node 18's built-in fetch and regex-based
// HTML parsing so nothing can break in the serverless bundle.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    return await analyze(event);
  } catch (err) {
    console.error('Unhandled analyzer error:', err);
    return json(500, { error: 'Analysis error', detail: err.message });
  }
};

async function analyze(event) {
  let url;
  try {
    ({ url } = JSON.parse(event.body));
  } catch {
    return json(400, { error: 'Invalid request body' });
  }
  if (!url || typeof url !== 'string') return json(400, { error: 'URL is required' });

  url = url.trim();
  try {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    new URL(url);
  } catch {
    return json(400, { error: 'That doesn\'t look like a valid URL' });
  }

  // Fetch the page — 7s budget leaves headroom inside the 10s function limit
  let html = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9'
      }
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Cap at ~500KB of HTML — plenty for head + main content signals
    html = (await res.text()).slice(0, 500000);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'it took too long to respond' : err.message;
    return json(422, {
      error: 'Unable to fetch website',
      detail: `We couldn't reach ${url} — ${reason}. The site may be blocking automated requests, or the URL may be incorrect.`
    });
  }

  const signals = extractSignals(html, url);

  let result = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      result = await analyzeWithClaude(url, signals, html);
    } catch (err) {
      console.error('Claude analysis failed, falling back to rules:', err.message);
    }
  }
  if (!result) result = analyzeWithRules(signals);

  return json(200, { url, ...result });
}

/* ---------- HTML signal extraction (regex-based, no dependencies) ---------- */

function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function extractSignals(html, url) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch ? stripTags(titleMatch[1]) : '';

  // Meta description — handle both attribute orders
  let metaDesc = '';
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (/name\s*=\s*["']description["']/i.test(tag)) {
      const m = tag.match(/content\s*=\s*["']([^"']*)["']/i);
      if (m) { metaDesc = m[1].trim(); break; }
    }
  }

  const headings = (re) => {
    const out = [];
    let m;
    while ((m = re.exec(html)) !== null && out.length < 15) {
      const text = stripTags(m[1]);
      if (text) out.push(text);
    }
    return out;
  };
  const h1s = headings(/<h1[^>]*>([\s\S]*?)<\/h1>/gi);
  const h2s = headings(/<h2[^>]*>([\s\S]*?)<\/h2>/gi);

  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  const totalImages = imgTags.length;
  const imagesWithoutAlt = imgTags.filter(t => !/\balt\s*=/i.test(t)).length;

  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  const hasCanonical = linkTags.some(t => /rel\s*=\s*["']canonical["']/i.test(t));

  const hasSchema = /application\/ld\+json/i.test(html) || /schema\.org/i.test(html);
  const hasOG = /property\s*=\s*["']og:title["']/i.test(html);
  const hasViewport = metaTags.some(t => /name\s*=\s*["']viewport["']/i.test(t));
  const isHttps = url.startsWith('https://');
  const hasFAQ = /faq|frequently asked/i.test(html);

  // Visible text: drop scripts/styles/head, then strip tags
  const bodyHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/^[\s\S]*?<body[^>]*>/i, ' ');
  const bodyText = stripTags(bodyHtml);
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  return {
    pageTitle, metaDesc, h1s, h2s, totalImages, imagesWithoutAlt,
    hasCanonical, hasSchema, hasOG, hasViewport, isHttps, wordCount, hasFAQ,
    contentSnippet: bodyText.slice(0, 2500)
  };
}

/* ---------- Claude analysis (direct API call, no SDK) ---------- */

function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1]);
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return JSON.parse(braceMatch[0]);
  throw new Error('No JSON object found in response');
}

async function analyzeWithClaude(url, s, html) {
  const prompt = `You are an expert SEO and AI search (GEO) consultant. Analyse this page data and identify the 2 highest-impact SEO improvements and the single highest-impact AI search improvement.

URL: ${url}
Title: ${s.pageTitle || 'MISSING'}
Meta Description: ${s.metaDesc || 'MISSING'}
H1s: ${s.h1s.join(' | ') || 'NONE'}
H2s: ${s.h2s.join(' | ') || 'NONE'}
Images: ${s.totalImages} total, ${s.imagesWithoutAlt} missing alt text
Canonical: ${s.hasCanonical}, Schema markup: ${s.hasSchema}, Open Graph: ${s.hasOG}
Viewport: ${s.hasViewport}, HTTPS: ${s.isHttps}, Word count: ${s.wordCount}, FAQ content: ${s.hasFAQ}

Content snippet:
${s.contentSnippet}

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "seoImprovements": [
    {"title": "<short, specific title>", "description": "<2 sentences: what the problem is and why it matters, in plain business-owner language>", "fix": "<1-2 sentence actionable fix>"},
    {"title": "...", "description": "...", "fix": "..."}
  ],
  "aiImprovement": {"title": "<short title>", "description": "<2 sentences on why this matters for being cited by ChatGPT, Gemini, Perplexity and Google AI Overviews>", "fix": "<1-2 sentence actionable fix>"}
}
Rules: exactly 2 seoImprovements. Be specific to THIS site, not generic. Plain language, no jargon.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  clearTimeout(timer);

  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  const parsed = extractJson(data.content[0].text.trim());
  if (!Array.isArray(parsed.seoImprovements) || !parsed.aiImprovement) {
    throw new Error('Unexpected response shape');
  }
  return parsed;
}

/* ---------- Rule-based analysis (always available) ---------- */

function analyzeWithRules(s) {
  const seoCandidates = [];

  if (!s.pageTitle) {
    seoCandidates.push({
      score: 100,
      title: 'Your page has no title tag',
      description: 'The title tag is the single strongest on-page ranking signal and the headline people see in Google results. Without one, Google has to guess what your page is about.',
      fix: 'Add a unique, descriptive <title> of 50–60 characters that includes your main service and location, e.g. "Emergency Plumber Perth | 24/7 Call-Outs".'
    });
  } else if (s.pageTitle.length < 30 || s.pageTitle.length > 65) {
    seoCandidates.push({
      score: 70,
      title: `Your title tag is ${s.pageTitle.length < 30 ? 'too short' : 'too long'} (${s.pageTitle.length} characters)`,
      description: 'Titles outside the 50–60 character sweet spot either waste valuable keyword space or get cut off in Google results, lowering click-through rates.',
      fix: 'Rewrite the title to 50–60 characters, leading with your most important keyword and ending with your brand name.'
    });
  }

  if (!s.metaDesc) {
    seoCandidates.push({
      score: 90,
      title: 'Missing meta description',
      description: 'The meta description is your free ad in Google results. Without one, Google pulls random text from the page, which rarely convinces anyone to click.',
      fix: 'Write a 140–160 character meta description that states what you do, who it\'s for, and gives a reason to click.'
    });
  }

  if (s.h1s.length === 0) {
    seoCandidates.push({
      score: 85,
      title: 'No H1 heading on the page',
      description: 'The H1 tells Google and visitors what the page is about. Pages without one consistently underperform in rankings.',
      fix: 'Add a single, clear H1 near the top of the page that includes your primary keyword.'
    });
  } else if (s.h1s.length > 1) {
    seoCandidates.push({
      score: 55,
      title: `Multiple H1 headings found (${s.h1s.length})`,
      description: 'More than one H1 dilutes the page\'s topical focus and can confuse search engines about what the page is really about.',
      fix: 'Keep one H1 for the main topic and demote the others to H2s.'
    });
  }

  if (s.totalImages > 0 && s.imagesWithoutAlt / s.totalImages > 0.3) {
    seoCandidates.push({
      score: 60,
      title: `${s.imagesWithoutAlt} of ${s.totalImages} images are missing alt text`,
      description: 'Alt text helps Google understand your images and is a ranking factor for image search — plus it\'s an accessibility requirement.',
      fix: 'Add short, descriptive alt text to every meaningful image, naturally including relevant keywords where they fit.'
    });
  }

  if (s.wordCount < 300) {
    seoCandidates.push({
      score: 80,
      title: `Thin content — only ${s.wordCount} words on the page`,
      description: 'Pages with very little text struggle to rank because Google has almost nothing to judge relevance from. Competitive pages typically carry 600+ words.',
      fix: 'Expand the page with genuinely useful content: what you do, who you serve, common questions, and proof like reviews or case studies.'
    });
  }

  if (!s.isHttps) {
    seoCandidates.push({
      score: 95,
      title: 'Site is not served over HTTPS',
      description: 'Google flags non-HTTPS sites as "Not secure" and uses HTTPS as a ranking signal. It actively costs you trust and rankings.',
      fix: 'Install an SSL certificate (free via Let\'s Encrypt or your host) and redirect all HTTP traffic to HTTPS.'
    });
  }

  if (!s.hasCanonical) {
    seoCandidates.push({
      score: 45,
      title: 'No canonical tag set',
      description: 'Without a canonical tag, duplicate versions of your pages (www vs non-www, trailing slashes, tracking URLs) can split your ranking strength.',
      fix: 'Add a <link rel="canonical"> tag to every page pointing at its preferred URL.'
    });
  }

  if (!s.hasViewport) {
    seoCandidates.push({
      score: 75,
      title: 'Page is not mobile-optimised',
      description: 'There\'s no viewport meta tag, which means the page likely renders poorly on phones. Google ranks the mobile version of your site first.',
      fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> and check the page on a phone.'
    });
  }

  if (!s.hasOG) {
    seoCandidates.push({
      score: 35,
      title: 'No social sharing (Open Graph) tags',
      description: 'When your page is shared on Facebook, LinkedIn or in messaging apps it shows up bare — no image, no headline — which kills click-throughs.',
      fix: 'Add og:title, og:description and og:image meta tags so shares look professional.'
    });
  }

  seoCandidates.sort((a, b) => b.score - a.score);
  const seoImprovements = seoCandidates.slice(0, 2).map(({ score, ...rest }) => rest);

  while (seoImprovements.length < 2) {
    seoImprovements.push({
      title: 'Strengthen internal linking and topical depth',
      description: 'Your basics look solid, so the biggest remaining gains come from building out supporting content and linking related pages together to build topical authority.',
      fix: 'Publish supporting pages for each core service and link them to and from your main pages with descriptive anchor text.'
    });
  }

  let aiImprovement;
  if (!s.hasSchema) {
    aiImprovement = {
      title: 'Add structured data (schema markup)',
      description: 'AI assistants like ChatGPT, Perplexity and Google AI Overviews rely heavily on structured data to understand who you are, what you offer and whether to cite you. Your page has none, making you nearly invisible to AI search.',
      fix: 'Add JSON-LD schema for your Organization/LocalBusiness plus FAQPage or Service schema on key pages.'
    };
  } else if (!s.hasFAQ) {
    aiImprovement = {
      title: 'Add question-and-answer content',
      description: 'AI search engines answer questions, and they cite pages that ask and answer those questions directly. Your page has no FAQ-style content, so AI assistants have nothing quotable to pull from.',
      fix: 'Add an FAQ section answering the 5–8 questions customers actually ask, in plain language, marked up with FAQPage schema.'
    };
  } else {
    aiImprovement = {
      title: 'Make your content directly quotable by AI',
      description: 'AI assistants cite pages that give clear, self-contained answers with evidence. Restructuring key sections into direct answers dramatically increases your chance of being the cited source.',
      fix: 'Open each key section with a 1–2 sentence direct answer, then back it with specifics — numbers, locations, credentials — that AI models can quote.'
    };
  }

  return { seoImprovements, aiImprovement };
}
