// Netlify Background Function — runs up to 15 minutes, returns 202 immediately.
// Triggered by stripe-webhook after confirmed payment, or manually from admin panel.

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Extract the outermost JSON object from Claude's response,
// handling markdown code fences and any surrounding prose.
function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1]);
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return JSON.parse(braceMatch[0]);
  throw new Error('No JSON object found in Claude response');
}

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

  const { auditId, adminKey } = body;
  if (!auditId) {
    console.error('generate-full-report-background: no auditId provided');
    return { statusCode: 400, body: JSON.stringify({ error: 'auditId required' }) };
  }

  // Load audit
  const { data: audit, error: auditError } = await supabase
    .from('audits')
    .select('*')
    .eq('id', auditId)
    .single();

  if (auditError || !audit) {
    console.error('Audit not found:', auditId);
    return { statusCode: 404, body: JSON.stringify({ error: 'Audit not found' }) };
  }

  // Guard: only run for paid audits (or admin-triggered re-runs)
  const isAdminCall = adminKey && adminKey === process.env.ADMIN_PASSWORD;
  if (!isAdminCall && audit.payment_status !== 'paid') {
    console.warn(`Skipping unpaid audit: ${auditId}`);
    return { statusCode: 403, body: JSON.stringify({ error: 'Payment required' }) };
  }

  // Skip if already done
  if (audit.status === 'paid_complete') {
    console.log(`Audit ${auditId} already complete`);
    return { statusCode: 200, body: JSON.stringify({ message: 'Already complete' }) };
  }

  const { url, email, name } = audit;
  if (!url) {
    await supabase.from('audits').update({ status: 'failed' }).eq('id', auditId);
    return { statusCode: 400, body: JSON.stringify({ error: 'Audit has no URL' }) };
  }

  try {
    await supabase.from('audits').update({ status: 'analyzing' }).eq('id', auditId);

    // Fetch page
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
    const hostname = new URL(url).hostname;
    const internalLinks = $('a[href]').filter((_, el) => { const h = $(el).attr('href')||''; return h.startsWith('/') || h.includes(hostname); }).length;
    const externalLinks = $('a[href]').filter((_, el) => { const h = $(el).attr('href')||''; return h.startsWith('http') && !h.includes(hostname); }).length;
    const hasFAQ = html.toLowerCase().includes('faq') || html.toLowerCase().includes('frequently asked');
    const contentSnippet = bodyText.slice(0, 5000);
    const domain = hostname.replace('www.', '');

    const fullPrompt = `You are a world-class SEO and AI search optimisation consultant. Produce a complete, detailed audit.

URL: ${url}
Domain: ${domain}
Title: ${pageTitle || 'MISSING'}
Meta Description: ${metaDesc || 'MISSING'}
H1s: ${h1s.join(' | ') || 'NONE FOUND'}
H2s: ${h2s.join(' | ') || 'NONE'}
H3s: ${h3s.join(' | ') || 'NONE'}
Images: ${totalImages} total, ${imagesWithoutAlt} missing alt text
Schema: ${hasSchema}, Canonical: ${Boolean(canonicalUrl)}, Robots: ${robotsMeta || 'none'}
Viewport: ${html.includes('viewport')}, HTTPS: ${url.startsWith('https://')}
OG: ${hasOG}, Twitter: ${hasTwitter}, FAQ section: ${hasFAQ}
Word count: ${wordCount}, Internal links: ${internalLinks}, External links: ${externalLinks}

Content (first 5000 chars):
${contentSnippet}

Return ONLY a raw JSON object (no markdown, no code fences, no explanation):
{
  "seoScore": <0-100>,
  "aiScore": <0-100>,
  "overallScore": <0-100>,
  "summary": "<comprehensive 3-4 sentence executive summary>",
  "strengths": ["<5-8 specific strengths>"],
  "quickWins": ["<5 specific quick wins>"],
  "issues": [
    {
      "priority": "critical|high|medium|low",
      "category": "technical|content|on-page|ai-search|performance|off-page",
      "title": "<concise title>",
      "description": "<detailed explanation>",
      "impact": "<business impact>",
      "fix": "<step-by-step fix>",
      "effort": "low|medium|high"
    }
  ],
  "competitorAnalysis": [
    {
      "name": "<competitor name>",
      "url": "<competitor URL>",
      "overallScore": <0-100>,
      "seoScore": <0-100>,
      "aiScore": <0-100>,
      "strengths": ["<what they do well>"],
      "gaps": ["<where you can beat them>"]
    }
  ],
  "competitorInsights": "<2-3 sentences on competitive landscape>",
  "actionPlan": {
    "month1": ["<quick win task>","<task>","<task>","<task>","<task>"],
    "month2": ["<medium effort task>","<task>","<task>","<task>"],
    "month3": ["<strategic task>","<task>","<task>","<task>"]
  },
  "aiSearchOptimisation": {
    "eeat": "<E-E-A-T assessment>",
    "contentDepth": "<content depth assessment>",
    "entityOptimisation": "<entity/topic authority assessment>",
    "citations": "<AI citation likelihood>",
    "recommendations": [
      {"title":"<title>","description":"<why it matters for AI search>","fix":"<implementation step>"}
    ]
  }
}
Rules: issues list must have 10-20 items; 3 competitors in competitorAnalysis; be specific and actionable.`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      messages: [{ role: 'user', content: fullPrompt }]
    });

    const report = extractJson(message.content[0].text.trim());

    const reportUrl = `${process.env.SITE_URL || ''}/report.html?id=${auditId}`;

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

    if (email) {
      await sendReportEmail(email, name, url, reportUrl, report.overallScore);
    }

    console.log(`Report complete for audit ${auditId}: score ${report.overallScore}`);
    return { statusCode: 200, body: JSON.stringify({ success: true, reportUrl }) };

  } catch (err) {
    console.error('Full report generation error:', err);
    await supabase.from('audits').update({ status: 'failed' }).eq('id', auditId);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function sendReportEmail(email, name, url, reportUrl, score) {
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
    const scoreColor = score >= 80 ? '#10b981' : score >= 60 ? '#3b82f6' : score >= 40 ? '#f59e0b' : '#ef4444';
    await transporter.sendMail({
      from: `SEO Audit Pro <${process.env.FROM_EMAIL || process.env.SMTP_USER}>`,
      to: email,
      subject: `Your SEO Report for ${domain} is ready`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">
        <div style="background:linear-gradient(135deg,#0f172a,#1e3a5f);padding:32px;text-align:center;border-radius:12px 12px 0 0;">
          <div style="font-size:1.5rem;font-weight:800;color:white;">⚡ SEO Audit Pro</div>
        </div>
        <div style="background:white;padding:32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
          <h2>Hi ${firstName},</h2>
          <p>Your full SEO and AI search report for <strong>${domain}</strong> is ready.</p>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
            <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Overall Score</div>
            <div style="font-size:3rem;font-weight:800;color:${scoreColor};">${score}</div>
            <div style="font-size:.875rem;color:#64748b;">/100</div>
          </div>
          <div style="text-align:center;margin:28px 0;">
            <a href="${reportUrl}" style="background:linear-gradient(135deg,#3b82f6,#6366f1);color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;">View Your Full Report →</a>
          </div>
          <p style="font-size:.875rem;color:#94a3b8;">Or copy: ${reportUrl}</p>
        </div>
      </body></html>`
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}
