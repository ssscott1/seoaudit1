const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { auditId, email, name, plan, url } = body;

  if (!email || !plan || !url) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email, plan and url are required' }) };
  }

  const isMonthly = plan === 'monthly';
  const siteUrl = process.env.SITE_URL || 'https://localhost:8888';

  try {
    // Create or retrieve Stripe customer
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        name: name || undefined,
        metadata: { auditId: auditId || '', url }
      });
    }

    const successParams = new URLSearchParams({
      session_id: '{CHECKOUT_SESSION_ID}',
      audit_id: auditId || '',
      email
    });

    let session;
    if (isMonthly) {
      // Subscription checkout
      session = await stripe.checkout.sessions.create({
        customer: customer.id,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{
          price: process.env.STRIPE_PRICE_MONTHLY,
          quantity: 1
        }],
        metadata: { auditId: auditId || '', url, email, name: name || '', plan },
        success_url: `${siteUrl}/success.html?${successParams}`,
        cancel_url: `${siteUrl}/analysis.html?url=${encodeURIComponent(url)}`,
        customer_email: customer.email ? undefined : email,
        allow_promotion_codes: true,
        subscription_data: {
          metadata: { url, email, name: name || '' }
        }
      });
    } else {
      // One-time payment
      session = await stripe.checkout.sessions.create({
        customer: customer.id,
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price: process.env.STRIPE_PRICE_ONE_TIME,
          quantity: 1
        }],
        metadata: { auditId: auditId || '', url, email, name: name || '', plan },
        success_url: `${siteUrl}/success.html?${successParams}`,
        cancel_url: `${siteUrl}/analysis.html?url=${encodeURIComponent(url)}`,
        allow_promotion_codes: true
      });
    }

    // Update audit record with session details
    if (auditId) {
      await supabase
        .from('audits')
        .update({
          email,
          name: name || null,
          plan,
          stripe_session_id: session.id,
          status: 'pending'
        })
        .eq('id', auditId);
    } else {
      // Create audit record if one doesn't exist yet
      await supabase
        .from('audits')
        .insert({
          url,
          email,
          name: name || null,
          plan,
          stripe_session_id: session.id,
          status: 'pending'
        });
    }

    // Upsert contact
    await supabase
      .from('contacts')
      .upsert({
        email,
        name: name || null,
        website: url,
        updated_at: new Date().toISOString()
      }, { onConflict: 'email', ignoreDuplicates: false });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ url: session.url, sessionId: session.id })
    };
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Checkout creation failed', detail: err.message })
    };
  }
};
