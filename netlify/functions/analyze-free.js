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
    new URL(url); // validate
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid URL format' }) };
  }

  // Fetch the page
  let html = '';
  let fetchError = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const pageRes = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0; +https://seoauditpro.com)',
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

  // Parse HTML with Cheerio
  const $ = cheerio.load(html);

  const pageTitle = $('title').first().text().trim() || '';
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 10);
  const h3s = $('h3').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 8);

  const images = $('img');
  const totalImages = images.length;
  const imagesWithoutAlt = images.filter((_, el) => !$(el).attr('alt')).length;

  const canonicalUrl = $('link[rel="canonical"]').attr('href') || '';
  const robotsMeta = $('meta[name="robots"]').attr('content') || '';
  const hasSchema = html.includes('application/ld+json') || html.includes('itemtype="http://schema.org') || html.includes('itemtype="https://schema.org');
  const hasSitemap = html.toLowerCase().includes('sitemap');
  const hasOpenGraph = $('meta[property="og:title"]').length > 0;
  const hasTwitterCard = $('meta[name="twitter:card"]').length > 0;

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  const internalLinks = $('a[href]').filter((_, el) => {
    const href = $(el).attr('href') || '';
    return href.startsWith('/') || href.includes(new URL(url).hostname);
  }).length;

  const externalLinks = $('a[href]').filter((_, el) => {
    const href = $(el).attr('href') || '';
    return href.startsWith('http') && !href.includes(new URL(url).hostname);
  }).length;

  const viewportMeta = $('meta[name="viewport"]').attr('content') || '';
  const hasViewport = Boolean(viewportMeta);
  const hasHttps = url.startsWith('https://');

  const contentSnippet = bodyText.slice(0, 3000);

  // Build Claude prompt
  const prompt = `You are an expert SEO analyst and AI search optimisation specialist. Analyse this website data and return a JSON report.

Website URL: ${url}
Page Title: ${pageTitle || 'MISSING'}
Meta Description: ${metaDesc || 'MISSING'}
H1 Tags: ${h1s.length ? h1s.join(' | ') : 'NONE FOUND'}
H2 Tags (first 10): ${h2s.length ? h2s.join(' | ') : 'NONE'}
H3 Tags (first 8): ${h3s.length ? h3s.join(' | ') : 'NONE'}
Total Images: ${totalImages}
Images Missing Alt Text: ${imagesWithoutAlt}
Has Schema Markup: ${hasSchema}
Has Canonical URL: ${Boolean(canonicalUrl)}
Robots Meta: ${robotsMeta || 'none'}
Has Viewport Meta: ${hasViewport}
Has HTTPS: ${hasHttps}
Has Open Graph Tags: ${hasOpenGraph}
Has Twitter Card: ${hasTwitterCard}
Has Sitemap Reference: ${hasSitemap}
Word Count: ${wordCount}
Internal Links: ${internalLinks}
External Links: ${externalLinks}

Content Snippet (first 3000 chars):
${contentSnippet}

Return ONLY valid JSON in this exact structure (no markdown, no explanation):
{
  "seoScore": <integer 0-100>,
  "aiScore": <integer 0-100>,
  "overallScore": <integer 0-100, weighted average>,
  "summary": "<2-3 sentence overview of the site's SEO health>",
  "strengths": [
    "<strength 1>",
    "<strength 2>",
    "<strength 3>"
  ],
  "topIssues": [
    {
      "priority": "critical|high|medium|low",
      "category": "technical|content|on-page|ai-search|performance",
      "title": "<concise issue title>",
      "description": "<what the issue is and why it matters>",
      "fix": "<specific actionable fix>"
    }
  ],
  "issueCount": <total number of SEO issues found>,
  "quickWins": ["<quick win 1>", "<quick win 2>", "<quick win 3>"]
}

Rules:
- topIssues must contain exactly 3 items (the most impactful ones)
- Scores should be realistic and accurate — don't be too generous
- If title is missing, that's critical. If meta desc is missing, that's high priority.
- AI search score evaluates: E-E-A-T signals, content depth, FAQ/Q&A format, schema markup, entity clarity
- issueCount is the TOTAL number of issues you've identified (not just the 3 shown)`;

  let analysisResult;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    analysisResult = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Analysis failed', detail: err.message })
    };
  }

  // Store in Supabase
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
      issueCount: analysisResult.issueCount || analysisResult.topIssues?.length || 3,
      quickWins: analysisResult.quickWins || [],
      pageTitle,
      wordCount
    })
  };
};
