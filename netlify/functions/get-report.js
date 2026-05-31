const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const { id } = event.queryStringParameters || {};
  if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };

  // UUID format validation
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid audit ID' }) };
  }

  const { data: audit, error } = await supabase
    .from('audits')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !audit) {
    return {
      statusCode: 404,
      headers: CORS,
      body: JSON.stringify({ error: 'Report not found', detail: 'The report may still be generating. Please wait a moment and refresh.' })
    };
  }

  // Only serve paid reports
  if (audit.payment_status !== 'paid' && audit.status !== 'paid_complete') {
    return {
      statusCode: 403,
      headers: CORS,
      body: JSON.stringify({
        error: 'Payment required',
        detail: 'This report requires a paid plan. Please purchase to access the full report.'
      })
    };
  }

  if (audit.status === 'analyzing') {
    return {
      statusCode: 202,
      headers: CORS,
      body: JSON.stringify({ status: 'analyzing', message: 'Your report is still being generated. Please check back in a moment.' })
    };
  }

  if (audit.status === 'failed') {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Analysis failed', detail: 'The analysis encountered an error. Please contact support.' })
    };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      id: audit.id,
      url: audit.url,
      pageTitle: audit.page_title,
      seoScore: audit.seo_score,
      aiScore: audit.ai_score,
      overallScore: audit.overall_score,
      topIssues: audit.top_issues,
      fullIssues: audit.full_issues,
      strengths: audit.strengths,
      competitorAnalysis: audit.competitor_analysis,
      actionPlan: audit.action_plan,
      fullReportData: audit.full_report_data,
      wordCount: audit.word_count,
      createdAt: audit.created_at,
      completedAt: audit.completed_at
    })
  };
};
