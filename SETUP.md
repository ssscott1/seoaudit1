# SEO Audit Pro — Setup Guide

## Stack
- **Frontend**: Vanilla HTML/CSS/JS hosted on Netlify
- **Backend**: Netlify Serverless Functions (Node.js)
- **Database**: Supabase (PostgreSQL)
- **Payments**: Stripe
- **AI Analysis**: Anthropic Claude API

---

## Step 1: Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the entire contents of `supabase/schema.sql`
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon/public key** → `SUPABASE_ANON_KEY`
   - **service_role key** → `SUPABASE_SERVICE_KEY`

---

## Step 2: Stripe Setup

1. Create a [Stripe](https://stripe.com) account
2. In **Products**, create two products:

   **Product 1: Full SEO Report**
   - Price: $199.00 USD, one-time
   - Copy the **Price ID** → `STRIPE_PRICE_ONE_TIME`

   **Product 2: Monthly SEO Audit**
   - Price: $49.00 USD, recurring monthly
   - Copy the **Price ID** → `STRIPE_PRICE_MONTHLY`

3. Go to **Developers → API Keys**:
   - Copy **Secret key** → `STRIPE_SECRET_KEY`

4. Go to **Developers → Webhooks**:
   - Add endpoint: `https://your-site.netlify.app/.netlify/functions/stripe-webhook`
   - Select events:
     - `checkout.session.completed`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_succeeded`
     - `invoice.payment_failed`
   - Copy **Signing secret** → `STRIPE_WEBHOOK_SECRET`

---

## Step 3: Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key → `ANTHROPIC_API_KEY`

---

## Step 4: GitHub Repository

1. Push this code to a GitHub repository
2. The repo is connected to Netlify for auto-deploy

---

## Step 5: Netlify Setup

1. Create a new site at [netlify.com](https://netlify.com) → **Import from GitHub**
2. Select your repository
3. Build settings:
   - Build command: *(leave empty)*
   - Publish directory: `.`
4. Go to **Site Settings → Environment Variables** and add all variables:

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
SUPABASE_ANON_KEY=eyJ...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ONE_TIME=price_...
STRIPE_PRICE_MONTHLY=price_...
SITE_URL=https://your-site.netlify.app
ADMIN_PASSWORD=choose-a-strong-password
SMTP_HOST=smtp.gmail.com          (optional, for email)
SMTP_PORT=587                      (optional)
SMTP_USER=your@gmail.com           (optional)
SMTP_PASS=your-app-password        (optional)
FROM_EMAIL=reports@yourdomain.com  (optional)
```

5. **Deploy the site**

---

## Step 6: Email Setup (Optional)

For Gmail:
1. Enable 2FA on your Google account
2. Go to **Google Account → Security → App Passwords**
3. Create an app password for "Mail"
4. Use that as `SMTP_PASS`

For other providers (SendGrid, Mailgun, etc.), adjust `SMTP_HOST` and credentials accordingly.

---

## Admin Dashboard

Access at: `https://your-site.netlify.app/admin/`

Login with the `ADMIN_PASSWORD` you set in environment variables.

Features:
- Dashboard with live stats (total audits, revenue, subscribers)
- Full audit list with search and filtering
- Contact/CRM database
- Subscription management
- Payment history
- Export to CSV

---

## URL Structure

| Page | URL |
|------|-----|
| Landing page | `/` |
| Analysis (free) | `/analysis.html?url=https://example.com` |
| Payment success | `/success.html?session_id=...&audit_id=...` |
| Full report | `/report.html?id={auditId}` |
| Admin dashboard | `/admin/` |

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analyze-free` | POST | Run free SEO analysis |
| `/api/create-checkout` | POST | Create Stripe checkout session |
| `/api/stripe-webhook` | POST | Stripe webhook handler |
| `/api/get-report` | GET | Fetch full paid report |
| `/api/check-status` | GET | Poll report generation status |
| `/api/generate-full-report` | POST | Trigger full report generation |
| `/api/admin-api` | GET | Admin data API |

---

## Testing

### Test the free analysis
```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/analyze-free \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### Test Stripe locally
Install Stripe CLI and run:
```bash
stripe listen --forward-to localhost:8888/.netlify/functions/stripe-webhook
```

### Local development
```bash
npm install -g netlify-cli
npm install
netlify dev
```

---

## Monthly Subscription Flow

1. User selects "Monthly Audit" plan → Stripe subscription created
2. On `checkout.session.completed` → first full report generated
3. On each `invoice.payment_succeeded` (monthly cycle) → new full audit triggered automatically
4. User receives email with each new report

---

## Troubleshooting

**"Unable to fetch website"**: Some sites block server-side requests. This is a limitation of the target site, not a bug.

**Report not appearing**: Check Netlify Function logs in the Netlify dashboard. The full report takes 30-90 seconds to generate.

**Stripe webhook failing**: Ensure the webhook secret matches exactly and the endpoint URL is correct.

**Supabase RLS errors**: The functions use the service role key which bypasses RLS. Ensure `SUPABASE_SERVICE_KEY` is set correctly (not the anon key).
