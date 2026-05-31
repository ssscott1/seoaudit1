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
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const siteUrl = process.env.SITE_URL || 'https://localhost:8888';

  try {
    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const { auditId, url, email, name, plan } = session.metadata || {};

        const isSubscription = session.mode === 'subscription';
        const amount = session.amount_total || 0;

        // Find or create audit record
        let audit = null;
        if (auditId) {
          const { data } = await supabase.from('audits').select('*').eq('id', auditId).single();
          audit = data;
        }

        if (!audit && session.metadata?.url) {
          // Find by session ID
          const { data } = await supabase.from('audits').select('*').eq('stripe_session_id', session.id).single();
          audit = data;
        }

        if (!audit) {
          // Create new audit record
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
          // Update existing audit
          await supabase
            .from('audits')
            .update({
              status: 'analyzing',
              payment_status: 'paid',
              amount_paid: amount,
              email: email || session.customer_details?.email,
              name: name || session.customer_details?.name,
              stripe_payment_intent: session.payment_intent,
              stripe_subscription_id: session.subscription || null
            })
            .eq('id', audit.id);
        }

        // Handle subscription record
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

        // Update contact record
        const contactEmail = email || session.customer_details?.email;
        if (contactEmail) {
          const { data: contact } = await supabase.from('contacts').select('*').eq('email', contactEmail).single();
          await supabase
            .from('contacts')
            .upsert({
              email: contactEmail,
              name: name || session.customer_details?.name || contact?.name,
              website: url || audit?.url || contact?.website,
              total_spent: (contact?.total_spent || 0) + amount,
              total_audits: (contact?.total_audits || 0) + 1,
              is_subscriber: isSubscription || contact?.is_subscriber || false,
              updated_at: new Date().toISOString()
            }, { onConflict: 'email' });
        }

        // Trigger full report generation asynchronously
        if (audit?.id) {
          // Fire and forget — call our own function
          fetch(`${siteUrl}/.netlify/functions/generate-full-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ auditId: audit.id })
          }).catch(err => console.error('Report generation trigger failed:', err));
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

        // Update contact
        const { data: subData } = await supabase.from('subscriptions').select('email').eq('stripe_subscription_id', sub.id).single();
        if (subData?.email) {
          // Check if they have other active subs
          const { data: otherSubs } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('email', subData.email)
            .eq('status', 'active');
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
        // Monthly renewal — trigger a new audit for subscribers
        const invoice = stripeEvent.data.object;
        if (invoice.subscription && invoice.billing_reason === 'subscription_cycle') {
          const { data: sub } = await supabase
            .from('subscriptions')
            .select('*')
            .eq('stripe_subscription_id', invoice.subscription)
            .single();

          if (sub?.url) {
            // Create a new audit for the monthly cycle
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
              fetch(`${siteUrl}/.netlify/functions/generate-full-report`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auditId: newAudit.id })
              }).catch(err => console.error('Monthly report trigger failed:', err));
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
