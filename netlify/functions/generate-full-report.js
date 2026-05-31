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
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { auditId } = body;
  if (!auditId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'auditId required' }) };

  // Load audit from DB
  const { data: audit, error: auditError } = await supabase
    .from('audits')
    .select('*')
    .eq('id', auditId)
    .single();

  if (auditError || !audit) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Audit not found' }) };
  }

  const { url, email, name } = audit;
  if (!url) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Audit has no URL' }) };

  try {
    // Mark as analyzing
    await supabase.from('audits').update({ status: 'analyzing' }).eq('id', auditId);

    // Fetch main page
    let html = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)', 'Accept': 'text/html' }
      });
      clearTimeout(timeout);
      html = await res.text();
    } catch (e) {
      console.warn('Page fetch failed:', e.message);
    }

    const $ = cheerio.load(html || '<html><body></body></html>');
    const pageTitle = $('title').first().text().trim() || '';
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const h2s = $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 15);
    const h3s = $('h3').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 12);
    const images = $('img');
    const totalImages = images.length;
    const imagesWithoutAlt = images.filter((_, el) => !$(el).attr('alt')).length;
    const canonicalUrl = $('link[rel="canonical"]').attr('href') || '';
    const robotsMeta = $('meta[name="robots"]').attr('content') || '';
    const hasSchema = html.includes('application/ld+json') || html.includes('itemtype="https://schema.org');
    const hasOG = $('meta[property="og:title"]').length > 0;
    const hasTwitter = $('meta[name="twitter:card"]').length > 0;
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
    const internalLinks = $('a[href]').filter((_, el) => { const h = $(el).attr('href')||''; return h.startsWith('/') || h.includes(new URL(url).hostname); }).length;
    const externalLinks = $('a[href]').filter((_, el) => { const h = $(el).attr('href')||''; return h.startsWith('http') && !h.includes(new URL(url).hostname); }).length;
    const hasFAQ = html.toLowerCase().includes('faq') || html.toLowerCase().includes('frequently asked');
    const contentSnippet = bodyText.slice(0, 5000);

    // Identify competitor domains (simple approach: same niche from content)
    const domain = new URL(url).hostname.replace('www.', '');

    // Build comprehensive analysis prompt
    const fullPrompt = `You are a world-class SEO and AI search optimisation consultant. Provide a complete, detailed audit of this website.

Website URL: ${url}
Domain: ${domain}
Page Title: ${pageTitle || 'MISSING'}
Meta Description: ${metaDesc || 'MISSING'}
H1 Tags: ${h1s.join(' | ') || 'NONE FOUND'}
H2 Tags: ${h2s.join(' | ') || 'NONE'}
H3 Tags: ${h3s.join(' | ') || 'NONE'}
Total Images: ${totalImages}, Missing Alt Text: ${imagesWithoutAlt}
Has Schema: ${hasSchema}, Has Canonical: ${Boolean(canonicalUrl)}
Robots: ${robotsMeta || 'none'}, Has Viewport: ${html.includes('viewport')}
Has HTTPS: ${url.startsWith('https://')}
Has Open Graph: ${hasOG}, Has Twitter Cards: ${hasTwitter}
Has FAQ section: ${hasFAQ}
Word Count: ${wordCount}
Internal Links: ${internalLinks}, External Links: ${externalLinks}

Content (first 5000 chars):
${contentSnippet}

Return ONLY valid JSON (no markdown, no explanation) in this exact structure:
{
  "seoScore": <0-100>,
  "aiScore": <0-100>,
  "overallScore": <0-100>,
  "summary": "<comprehensive 3-4 sentence executive summary>",
  "strengths": [<5-8 specific strengths found>],
  "quickWins": [<5 specific quick win actions>],
  "issues": [
    {
      "priority": "critical|high|medium|low",
      "category": "technical|content|on-page|ai-search|performance|off-page",
      "title": "<concise title>",
      "description": "<detailed explanation>",
      "impact": "<business impact of fixing this>",
      "fix": "<specific step-by-step fix>",
      "effort": "low|medium|high"
    }
  ],
  "competitorAnalysis": [
    {
      "name": "<likely competitor name based on niche>",
      "url": "<plausible competitor URL>",
      "overallScore": <estimated score 0-100>,
      "seoScore": <estimated 0-100>,
      "aiScore": <estimated 0-100>,
      "strengths": ["<what they likely do well>"],
      "gaps": ["<where you can beat them>"]
    },
    { ... second competitor ... },
    { ... third competitor ... }
  ],
  "competitorInsights": "<2-3 sentences on competitive landscape and opportunities>",
  "actionPlan": {
    "month1": [
      "<specific task with expected outcome>",
      "<specific task>",
      "<specific task>",
      "<specific task>",
      "<specific task>"
    ],
    "month2": [
      "<specific task>",
      "<specific task>",
      "<specific task>",
      "<specific task>"
    ],
    "month3": [
      "<specific task>",
      "<specific task>",
      "<specific task>",
      "<specific task>"
    ]
  },
  "aiSearchOptimisation": {
    "eeat": "<detailed E-E-A-T assessment>",
    "contentDepth": "<assessment of content depth and originality>",
    "entityOptimisation": "<entity and topic authority assessment>",
    "citations": "<likelihood of being cited by AI assistants>",
    "recommendations": [
      {
        "title": "<recommendation title>",
        "description": "<why this matters for AI search>",
        "fix": "<specific implementation step>"
      }
    ]
  }
}

Rules:
- Issues list must have 10-20 items minimum, covering all severity levels
- Be specific and actionable — generic advice is not acceptable
- Competitor scores should be realistic estimates based on the industry
- Month 1 should be quick wins (low effort, high impact)
- Month 2 should be medium-effort improvements
- Month 3 should be strategic/long-term work
- AI score specifically evaluates: E-E-A-T, structured data, content format for AI extraction, FAQ/Q&A content, entity clarity`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      messages: [{ role: 'user', content: fullPrompt }]
    });

    const raw = message.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Claude response');
    const report = JSON.parse(jsonMatch[0]);

    // Build report URL with a simple token (auditId itself is sufficient as it's a UUID)
    const reportUrl = `${process.env.SITE_URL}/report.html?id=${auditId}`;

    // Save to Supabase
    await supabase
      .from('audits')
      .update({
        status: 'paid_complete',
        seo_score: report.seoScore,
        ai_score: report.aiScore,
        overall_score: report.overallScore,
        top_issues: (report.issues || []).slice(0, 3),
        strengths: report.strengths,
        full_issues: report.issues,
        competitor_analysis: report.competitorAnalysis,
        action_plan: report.actionPlan,
        full_report_data: report,
        page_title: pageTitle || audit.page_title,
        page_description: metaDesc || audit.page_description,
        word_count: wordCount || audit.word_count,
        completed_at: new Date().toISOString()
      })
      .eq('id', auditId);

    // Send email notification if email exists
    if (email) {
      await sendReportEmail(email, name, url, reportUrl, report.overallScore);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, reportUrl, overallScore: report.overallScore })
    };

  } catch (err) {
    console.error('Full report generation error:', err);
    await supabase.from('audits').update({ status: 'failed' }).eq('id', auditId);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Report generation failed', detail: err.message })
    };
  }
};

async function sendReportEmail(email, name, url, reportUrl, score) {
  // Only send if email config is available
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return;

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    const firstName = name ? name.split(' ')[0] : 'there';
    const domain = new URL(url).hostname.replace('www.', '');

    await transporter.sendMail({
      from: `SEO Audit Pro <${process.env.FROM_EMAIL || process.env.SMTP_USER}>`,
      to: email,
      subject: `Your SEO Report for ${domain} is ready`,
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Inter, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
          <div style="background: linear-gradient(135deg, #0f172a, #1e3a5f); padding: 32px; text-align: center; border-radius: 12px 12px 0 0;">
            <div style="font-size: 1.5rem; font-weight: 800; color: white;">⚡ SEO Audit Pro</div>
          </div>
          <div style="background: white; padding: 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
            <h2>Hi ${firstName},</h2>
            <p>Your full SEO and AI search report for <strong>${domain}</strong> is ready.</p>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
              <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 4px;">Overall Score</div>
              <div style="font-size: 3rem; font-weight: 800; color: ${score >= 80 ? '#10b981' : score >= 60 ? '#3b82f6' : score >= 40 ? '#f59e0b' : '#ef4444'};">${score}</div>
              <div style="font-size: 0.875rem; color: #64748b;">/100</div>
            </div>
            <p>Your report includes:</p>
            <ul style="color: #475569; line-height: 1.8;">
              <li>Complete prioritised issue list</li>
              <li>Competitor comparison analysis</li>
              <li>90-day SEO + AI search action plan</li>
              <li>AI search optimisation deep dive</li>
            </ul>
            <div style="text-align: center; margin: 28px 0;">
              <a href="${reportUrl}" style="background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 1rem;">View Your Full Report →</a>
            </div>
            <p style="font-size: 0.875rem; color: #94a3b8;">If the button doesn't work, copy this link: ${reportUrl}</p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
            <p style="font-size: 0.8125rem; color: #94a3b8; text-align: center;">SEO Audit Pro · Powered by Claude AI<br>Questions? Reply to this email.</p>
          </div>
        </body>
        </html>
      `
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}
