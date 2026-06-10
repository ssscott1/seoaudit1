const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];

  // Netlify may base64-encode the body for binary content types.
  // Stripe signature verification requires the raw bytes, so decode if needed.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const siteUrl = process.env.SITE_URL || '';

  // Helper: trigger the background report generator and await its 202 response.
  // The background function does the heavy lifting asynchronously.
  async function triggerReport(auditId) {
    try {
      const res = await fetch(`${siteUrl}/.netlify/functions/generate-full-report-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId })
      });
      if (!res.ok) console.error(`Report trigger returned ${res.status} for audit ${auditId}`);
    } catch (err) {
      console.error('Report trigger failed:', err.message);
    }
  }

  try {
    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const { auditId, url, email, name, plan } = session.metadata || {};
        const isSubscription = session.mode === 'subscription';
        const amount = session.amount_total || 0;

        // Find the audit record — try by auditId first, then by session ID
        let audit = null;
        if (auditId) {
          const { data } = await supabase.from('audits').select('*').eq('id', auditId).single();
          audit = data;
        }
        if (!audit) {
          const { data } = await supabase.from('audits').select('*').eq('stripe_session_id', session.id).single();
          audit = data;
        }

        if (!audit) {
          const { data } = await supabase
            .from('audits')
            .insert({
              url: url || '',
              email: email || session.customer_details?.email,
              name: name || session.customer_details?.name,
              plan: plan || (isSubscription ? 'monthly' : 'one-time'),
              stripe_session_id: session.id,
              status: 'analyzing',
              payment_status: 'paid',
              amount_paid: amount
            })
            .select()
            .single();
          audit = data;
        } else {
          await supabase
            .from('audits')
            .update({
              status: 'analyzing',
              payment_status: 'paid',
              amount_paid: amount,
              email: email || session.customer_details?.email,
              name: name || session.customer_details?.name,
              stripe_payment_intent: session.payment_intent || null,
              stripe_subscription_id: session.subscription || null
            })
            .eq('id', audit.id);
        }

        if (isSubscription && session.subscription) {
          await supabase
            .from('subscriptions')
            .upsert({
              email: email || session.customer_details?.email,
              name: name || session.customer_details?.name,
              url: url || audit?.url,
              stripe_subscription_id: session.subscription,
              stripe_customer_id: session.customer,
              status: 'active',
              updated_at: new Date().toISOString()
            }, { onConflict: 'stripe_subscription_id' });
        }

        const contactEmail = email || session.customer_details?.email;
        if (contactEmail) {
          const { data: existingContact } = await supabase
            .from('contacts').select('total_spent, total_audits, is_subscriber').eq('email', contactEmail).single();
          await supabase
            .from('contacts')
            .upsert({
              email: contactEmail,
              name: name || session.customer_details?.name || null,
              website: url || audit?.url || null,
              total_spent: (existingContact?.total_spent || 0) + amount,
              total_audits: (existingContact?.total_audits || 0) + 1,
              is_subscriber: isSubscription || existingContact?.is_subscriber || false,
              updated_at: new Date().toISOString()
            }, { onConflict: 'email' });
        }

        if (audit?.id) {
          await triggerReport(audit.id);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        await supabase
          .from('subscriptions')
          .update({
            status: sub.status,
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('stripe_subscription_id', sub.id);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        await supabase
          .from('subscriptions')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);

        const { data: subData } = await supabase
          .from('subscriptions').select('email').eq('stripe_subscription_id', sub.id).single();
        if (subData?.email) {
          const { data: otherSubs } = await supabase
            .from('subscriptions').select('id').eq('email', subData.email).eq('status', 'active');
          if (!otherSubs?.length) {
            await supabase.from('contacts').update({ is_subscriber: false }).eq('email', subData.email);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        if (invoice.subscription) {
          await supabase
            .from('subscriptions')
            .update({ status: 'past_due', updated_at: new Date().toISOString() })
            .eq('stripe_subscription_id', invoice.subscription);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        if (invoice.subscription && invoice.billing_reason === 'subscription_cycle') {
          const { data: sub } = await supabase
            .from('subscriptions').select('*').eq('stripe_subscription_id', invoice.subscription).single();

          if (sub?.url) {
            const { data: newAudit } = await supabase
              .from('audits')
              .insert({
                url: sub.url,
                email: sub.email,
                name: sub.name,
                plan: 'monthly',
                status: 'analyzing',
                payment_status: 'paid',
                amount_paid: invoice.amount_paid,
                stripe_subscription_id: invoice.subscription
              })
              .select()
              .single();

            if (newAudit?.id) {
              await triggerReport(newAudit.id);
            }
          }
        }
        break;
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Webhook handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
