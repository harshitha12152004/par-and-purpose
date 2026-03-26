# Par & Purpose — Golf Charity Subscription Platform
### Full-Stack Build Guide · Digital Heroes Assignment

---

## Project Structure

```
par-and-purpose/
│
├── frontend/                    # Next.js (or static HTML)
│   ├── golf-charity-platform.html   ← Homepage UI
│   └── admin-dashboard.html         ← Admin Panel UI
│
├── backend/
│   ├── server.js                ← Express API (all routes)
│   ├── package.json
│   └── .env.example
│
└── database/
    └── schema.sql               ← Full Supabase schema + RLS + seed
```

---

## Tech Stack

| Layer        | Technology                          |
|-------------|-------------------------------------|
| Frontend     | HTML/CSS/JS → migrate to Next.js    |
| Backend API  | Node.js + Express                   |
| Database     | Supabase (PostgreSQL)               |
| Auth         | Supabase Auth (JWT)                 |
| Payments     | Stripe (Checkout + Webhooks)        |
| Email        | Nodemailer (SMTP)                   |
| Deployment   | Vercel (frontend + API as functions)|

---

## Step-by-Step Setup

### 1. Supabase Setup
1. Create new project at supabase.com (NEW project, not personal)
2. Go to SQL Editor → paste contents of `schema.sql` → Run
3. Copy your Project URL, anon key, and service key to `.env`
4. In Supabase Dashboard → Authentication → enable Email provider

### 2. Stripe Setup
1. Create account at stripe.com
2. Dashboard → Products → Add Product:
   - **Monthly Plan**: £9.00/month → copy Price ID
   - **Yearly Plan**: £99.00/year → copy Price ID
3. Developers → API Keys → copy publishable + secret keys
4. Developers → Webhooks → Add endpoint:
   - URL: `https://your-api.vercel.app/api/webhooks/stripe`
   - Events to listen: `checkout.session.completed`,
     `customer.subscription.updated`, `customer.subscription.deleted`,
     `invoice.payment_succeeded`, `invoice.payment_failed`
5. Copy webhook signing secret to `.env`

### 3. Backend Deployment (Vercel)
```bash
# Install Vercel CLI
npm i -g vercel

# From backend/ directory
vercel

# Add environment variables in Vercel Dashboard
# Project → Settings → Environment Variables
# Paste all values from .env.example
```

Add `vercel.json` to backend:
```json
{
  "version": 2,
  "builds": [{ "src": "server.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "server.js" }]
}
```

### 4. Frontend Deployment (Vercel — NEW account)
```bash
# Create NEW Vercel account (not personal)
# Upload frontend files via Vercel Dashboard → Import

# Set environment variables:
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=...
NEXT_PUBLIC_API_URL=https://your-api.vercel.app
```

---

## API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register + create Stripe checkout |
| POST | `/api/auth/refresh` | Refresh JWT token |

### Scores
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/scores` | ✓ | Get own scores (latest 5) |
| POST | `/api/scores` | ✓ | Add score (rolling 5 auto-managed) |
| DELETE | `/api/scores/:id` | ✓ | Delete a score |

### Draws
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/draws` | — | All published draws |
| GET | `/api/draws/current` | — | Latest draw |
| POST | `/api/admin/draws` | Admin | Create draw config |
| POST | `/api/admin/draws/:id/simulate` | Admin | Run draw simulation |
| POST | `/api/admin/draws/:id/publish` | Admin | Publish + compute winners |

### Winners
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/winners/:id/proof` | ✓ | Upload proof screenshot URL |
| GET | `/api/admin/winners/pending` | Admin | All pending verifications |
| PATCH | `/api/admin/winners/:id/verify` | Admin | Approve or reject |
| PATCH | `/api/admin/winners/:id/paid` | Admin | Mark as paid |

### Charities
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/charities` | — | All active charities |
| POST | `/api/admin/charities` | Admin | Add charity |
| PATCH | `/api/admin/charities/:id` | Admin | Edit charity |
| DELETE | `/api/admin/charities/:id` | Admin | Soft-delete charity |
| PATCH | `/api/profile/charity` | ✓ | Update own charity + % |

### Dashboard
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/dashboard` | ✓ | Full user dashboard data |
| GET | `/api/admin/users` | Admin | All users (paginated) |
| GET | `/api/admin/analytics` | Admin | Platform analytics |

---

## Score Rolling Logic
- Enforced by PostgreSQL trigger (`enforce_rolling_scores`)
- On insert of 6th score: oldest by `played_date ASC` is auto-deleted
- No application-level logic needed

## Prize Pool Calculation
```
Monthly revenue = (monthly_subs × £9) + (yearly_subs × £8.25)
Jackpot (40%)  = revenue × 0.40
Second  (35%)  = revenue × 0.35
Third   (25%)  = revenue × 0.25
```
- Splits computed by DB trigger on insert/update of `prize_pool_gbp`
- Jackpot rolls if no 5-match winner (flag: `jackpot_rolled = TRUE`)
- Rolled jackpot added to next month's pool automatically

## Draw Algorithm Options
- **Random**: `Math.random()` — pure lottery
- **Weighted**: numbers weighted by frequency in user score pool

---

## Testing Checklist (PRD Section 16)
- [ ] User signup → Stripe checkout → subscription created
- [ ] Login/logout flow
- [ ] Score entry → rolling 5 verified in DB
- [ ] Draw simulation → publish → winner records created
- [ ] Prize split (multiple winners same tier)
- [ ] Jackpot rollover (no 5-match)
- [ ] Charity selection + contribution calculation
- [ ] Winner proof upload → admin verify → mark paid
- [ ] Admin: user management, score edit, charity CRUD
- [ ] Email notifications sent for draw results + winner alerts
- [ ] Mobile responsive (all breakpoints)
- [ ] Lapsed subscription → restricted access

---

## Credentials for Evaluators

**User Test Account**
- URL: `https://your-app.vercel.app`
- Email: `testuser@parpose.co`
- Password: `TestUser123!`

**Admin Test Account**
- URL: `https://your-app.vercel.app/admin`
- Email: `admin@parpose.co`
- Password: `AdminUser123!`

---

*Built for Digital Heroes Full-Stack Trainee Selection · March 2026*
