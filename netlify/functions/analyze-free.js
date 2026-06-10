const fetch = require('node-fetch');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Safely extract the first JSON object from Claude's response,
// handling cases where it wraps output in markdown code fences.
function extractJson(text) {
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1]);
  // Fall back to matching the outermost { ... }
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return JSON.parse(braceMatch[0]);
  throw new Error('No JSON object found in Claude response');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let url;
  try {
    ({ url } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!url) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'URL is required' }) };

  // Normalise URL
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    new URL(url);
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid URL format' }) };
  }

  // Fetch the page — 7 second timeout leaves room for the Claude call
  let html = '';
  let fetchError = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const pageRes = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    clearTimeout(timeout);
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
    html = await pageRes.text();
  } catch (err) {
    fetchError = err.message;
  }

  if (!html && fetchError) {
    return {
      statusCode: 422,
      headers: CORS,
      body: JSON.stringify({
        error: 'Unable to fetch website',
        detail: `Could not access ${url}. The site may be blocking automated requests, or the URL is incorrect. (${fetchError})`
      })
    };
  }

  // Parse HTML
  const $ = cheerio.load(html);
  const pageTitle = $('title').first().text().trim() || '';
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 10);
  const images = $('img');
  const totalImages = images.length;
  const imagesWithoutAlt = images.filter((_, el) => !$(el).attr('alt')).length;
  const canonicalUrl = $('link[rel="canonical"]').attr('href') || '';
  const robotsMeta = $('meta[name="robots"]').attr('content') || '';
  const hasSchema = html.includes('application/ld+json') || html.includes('itemtype="https://schema.org');
  const hasOpenGraph = $('meta[property="og:title"]').length > 0;
  const hasTwitterCard = $('meta[name="twitter:card"]').length > 0;
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  const hostname = new URL(url).hostname;
  const internalLinks = $('a[href]').filter((_, el) => { const h = $(el).attr('href')||''; return h.startsWith('/') || h.includes(hostname); }).length;
  const externalLinks = $('a[href]').filter((_, el) => { const h = $(el).attr('href')||''; return h.startsWith('http') && !h.includes(hostname); }).length;
  const contentSnippet = bodyText.slice(0, 2500);

  const prompt = `You are an expert SEO analyst. Analyse this website data and return a concise JSON report.

URL: ${url}
Title: ${pageTitle || 'MISSING'}
Meta Description: ${metaDesc || 'MISSING'}
H1s: ${h1s.join(' | ') || 'NONE'}
H2s (first 10): ${h2s.join(' | ') || 'NONE'}
Images: ${totalImages} total, ${imagesWithoutAlt} missing alt text
Schema: ${hasSchema}, Canonical: ${Boolean(canonicalUrl)}, Robots: ${robotsMeta || 'none'}
Viewport: ${html.includes('viewport')}, HTTPS: ${url.startsWith('https://')}
OG tags: ${hasOpenGraph}, Twitter cards: ${hasTwitterCard}
Word count: ${wordCount}, Internal links: ${internalLinks}, External links: ${externalLinks}

Content snippet:
${contentSnippet}

Return ONLY a raw JSON object (no markdown, no code fences, no explanation):
{
  "seoScore": <integer 0-100>,
  "aiScore": <integer 0-100>,
  "overallScore": <integer 0-100>,
  "summary": "<2-3 sentences on overall SEO health>",
  "strengths": ["<strength 1>","<strength 2>","<strength 3>"],
  "topIssues": [
    {"priority":"critical|high|medium|low","category":"technical|content|on-page|ai-search|performance","title":"<title>","description":"<description>","fix":"<actionable fix>"},
    {"priority":"...","category":"...","title":"...","description":"...","fix":"..."},
    {"priority":"...","category":"...","title":"...","description":"...","fix":"..."}
  ],
  "issueCount": <total issues found>,
  "quickWins": ["<win 1>","<win 2>","<win 3>"]
}
topIssues must have exactly 3 items. Scores must be realistic.`;

  let analysisResult;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });

    analysisResult = extractJson(message.content[0].text.trim());
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Analysis failed', detail: err.message })
    };
  }

  // Store result
  const { data: audit, error: dbError } = await supabase
    .from('audits')
    .insert({
      url,
      status: 'free_complete',
      seo_score: analysisResult.seoScore,
      ai_score: analysisResult.aiScore,
      overall_score: analysisResult.overallScore,
      top_issues: analysisResult.topIssues,
      strengths: analysisResult.strengths,
      page_title: pageTitle,
      page_description: metaDesc,
      word_count: wordCount
    })
    .select('id')
    .single();

  if (dbError) console.error('Supabase insert error:', dbError);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      auditId: audit?.id || null,
      seoScore: analysisResult.seoScore,
      aiScore: analysisResult.aiScore,
      overallScore: analysisResult.overallScore,
      summary: analysisResult.summary,
      strengths: analysisResult.strengths || [],
      topIssues: analysisResult.topIssues || [],
      issueCount: analysisResult.issueCount || 3,
      quickWins: analysisResult.quickWins || [],
      pageTitle,
      wordCount
    })
  };
};
