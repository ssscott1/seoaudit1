const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

function checkAuth(event) {
  const key = event.headers['x-admin-key'];
  return key === process.env.ADMIN_PASSWORD;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  if (!checkAuth(event)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { action, limit, id } = event.queryStringParameters || {};

  try {
    switch (action) {

      case 'stats': {
        const [auditsRes, paidRes, subsRes, revenueRes] = await Promise.all([
          supabase.from('audits').select('id', { count: 'exact', head: true }),
          supabase.from('audits').select('id', { count: 'exact', head: true }).eq('payment_status', 'paid'),
          supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
          supabase.from('audits').select('amount_paid').eq('payment_status', 'paid')
        ]);

        const totalRevenue = (revenueRes.data || []).reduce((sum, r) => sum + (r.amount_paid || 0), 0);
        const mrr = ((subsRes.count || 0) * 4900); // $49 * active subscribers

        return {
          statusCode: 200, headers: CORS, body: JSON.stringify({
            totalAudits: auditsRes.count || 0,
            paidAudits: paidRes.count || 0,
            activeSubscriptions: subsRes.count || 0,
            totalRevenue,
            mrr
          })
        };
      }

      case 'audits': {
        const pageLimit = Math.min(parseInt(limit) || 50, 200);
        const { data, error } = await supabase
          .from('audits')
          .select('id, url, email, name, plan, status, payment_status, overall_score, seo_score, ai_score, amount_paid, created_at, completed_at')
          .order('created_at', { ascending: false })
          .limit(pageLimit);

        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ audits: data || [] }) };
      }

      case 'audit-detail': {
        if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id required' }) };
        const { data, error } = await supabase.from('audits').select('*').eq('id', id).single();
        if (error || !data) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ audit: data }) };
      }

      case 'contacts': {
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ contacts: data || [] }) };
      }

      case 'subscriptions': {
        const { data, error } = await supabase
          .from('subscriptions')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ subscriptions: data || [] }) };
      }

      case 'payments': {
        const { data, error } = await supabase
          .from('audits')
          .select('id, url, email, plan, payment_status, amount_paid, stripe_payment_intent, created_at')
          .eq('payment_status', 'paid')
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ payments: data || [] }) };
      }

      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
    }
  } catch (err) {
    console.error('Admin API error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
