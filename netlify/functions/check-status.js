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

  const { id, type } = event.queryStringParameters || {};
  if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id required' }) };

  try {
    let query = supabase.from('audits').select('id, status, payment_status, overall_score').limit(1);

    if (type === 'session') {
      query = query.eq('stripe_session_id', id);
    } else {
      // UUID validation
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(id)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid ID' }) };
      query = query.eq('id', id);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ status: 'not_found' }) };
    }

    const reportUrl = data.status === 'paid_complete'
      ? `/report.html?id=${data.id}`
      : null;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        status: data.status,
        paymentStatus: data.payment_status,
        score: data.overall_score,
        reportUrl
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
