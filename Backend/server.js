// ============================================================
// Par & Purpose · Golf Charity Subscription Platform
// Backend API — Node.js / Express
// Stack: Express · Supabase · Stripe · Nodemailer
// ============================================================

// package.json dependencies:
// express, @supabase/supabase-js, stripe, dotenv,
// cors, helmet, express-rate-limit, nodemailer, jsonwebtoken

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Clients ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY       // service key for backend use only
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ── Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ── Auth Middleware ───────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  // Fetch profile for role check
  const { data: profile } = await supabase
    .from('profiles').select('*').eq('id', user.id).single();
  req.profile = profile;
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.profile?.role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ============================================================
// AUTH ROUTES
// ============================================================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, plan, charity_id, charity_pct = 10 } = req.body;

  if (!email || !password || !full_name || !plan)
    return res.status(400).json({ error: 'Missing required fields' });

  if (!['monthly','yearly'].includes(plan))
    return res.status(400).json({ error: 'Invalid plan' });

  // 1. Create Supabase auth user
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true
  });
  if (authError) return res.status(400).json({ error: authError.message });

  const userId = authData.user.id;

  // 2. Create profile
  const { error: profileError } = await supabase.from('profiles').insert({
    id: userId, full_name, email, charity_id: charity_id || null,
    charity_pct: Math.max(10, Math.min(100, parseFloat(charity_pct)))
  });
  if (profileError) return res.status(500).json({ error: profileError.message });

  // 3. Create Stripe customer
  const customer = await stripe.customers.create({ email, name: full_name });

  // 4. Create Stripe checkout session
  const priceId = plan === 'monthly'
    ? process.env.STRIPE_MONTHLY_PRICE_ID
    : process.env.STRIPE_YEARLY_PRICE_ID;

  const session = await stripe.checkout.sessions.create({
    customer: customer.id,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${process.env.FRONTEND_URL}/pricing`,
    metadata: { userId, plan }
  });

  // 5. Send welcome email (queued)
  await supabase.from('notifications').insert({
    user_id: userId, type: 'welcome',
    subject: 'Welcome to Par & Purpose 🌿',
    status: 'queued',
    meta: { full_name, plan }
  });

  res.json({ checkoutUrl: session.url });
});

// POST /api/auth/login — handled by Supabase client, but token refresh:
app.post('/api/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ session: data.session });
});

// ============================================================
// STRIPE WEBHOOKS
// ============================================================
app.post('/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, plan } = session.metadata;
        const amount = plan === 'monthly' ? 9.00 : 99.00;

        // Get Stripe subscription details
        const stripeSub = await stripe.subscriptions.retrieve(session.subscription);

        await supabase.from('subscriptions').upsert({
          user_id: userId, plan, status: 'active',
          stripe_customer_id: session.customer,
          stripe_sub_id: session.subscription,
          amount_gbp: amount,
          current_period_start: new Date(stripeSub.current_period_start * 1000),
          current_period_end:   new Date(stripeSub.current_period_end   * 1000)
        });

        // Calculate and log charity donation
        const { data: profile } = await supabase
          .from('profiles').select('charity_id, charity_pct').eq('id', userId).single();

        if (profile?.charity_id) {
          const donationAmt = parseFloat((amount * (profile.charity_pct / 100)).toFixed(2));
          await supabase.from('charity_donations').insert({
            user_id: userId, charity_id: profile.charity_id,
            amount_gbp: donationAmt, donation_type: 'subscription'
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const { data: dbSub } = await supabase
          .from('subscriptions').select('user_id').eq('stripe_sub_id', sub.id).single();

        if (dbSub) {
          const statusMap = {
            active: 'active', past_due: 'past_due',
            canceled: 'cancelled', unpaid: 'lapsed'
          };
          await supabase.from('subscriptions').update({
            status: statusMap[sub.status] || sub.status,
            current_period_start: new Date(sub.current_period_start * 1000),
            current_period_end:   new Date(sub.current_period_end   * 1000)
          }).eq('stripe_sub_id', sub.id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('subscriptions').update({
          status: 'cancelled', cancelled_at: new Date()
        }).eq('stripe_sub_id', sub.id);
        break;
      }

      case 'invoice.payment_succeeded': {
        // Recurring payment — log another donation period
        const invoice = event.data.object;
        const { data: dbSub } = await supabase
          .from('subscriptions')
          .select('user_id, plan, amount_gbp')
          .eq('stripe_sub_id', invoice.subscription)
          .single();

        if (dbSub) {
          const { data: profile } = await supabase
            .from('profiles').select('charity_id, charity_pct').eq('id', dbSub.user_id).single();
          if (profile?.charity_id) {
            const donationAmt = parseFloat((dbSub.amount_gbp * (profile.charity_pct / 100)).toFixed(2));
            await supabase.from('charity_donations').insert({
              user_id: dbSub.user_id, charity_id: profile.charity_id,
              amount_gbp: donationAmt, donation_type: 'subscription'
            });
          }
          await sendNotification(dbSub.user_id, 'payment_receipt', {
            amount: dbSub.amount_gbp, plan: dbSub.plan
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await supabase.from('subscriptions').update({ status: 'past_due' })
          .eq('stripe_sub_id', invoice.subscription);
        break;
      }
    }

    res.json({ received: true });
  }
);

// ============================================================
// SCORES
// ============================================================

// GET /api/scores — current user's scores
app.get('/api/scores', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('scores')
    .select('*')
    .eq('user_id', req.user.id)
    .order('played_date', { ascending: false })
    .order('created_at',  { ascending: false })
    .limit(5);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ scores: data });
});

// POST /api/scores — add new score (rolling 5 handled by DB trigger)
app.post('/api/scores', requireAuth, async (req, res) => {
  const { score, played_date } = req.body;

  if (!score || score < 1 || score > 45)
    return res.status(400).json({ error: 'Score must be between 1 and 45' });
  if (!played_date)
    return res.status(400).json({ error: 'played_date required (YYYY-MM-DD)' });

  // Check active subscription
  const { data: sub } = await supabase
    .from('subscriptions').select('status').eq('user_id', req.user.id).single();
  if (!sub || sub.status !== 'active')
    return res.status(403).json({ error: 'Active subscription required to enter scores' });

  const { data, error } = await supabase.from('scores').insert({
    user_id: req.user.id, score: parseInt(score), played_date
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ score: data });
});

// DELETE /api/scores/:id
app.delete('/api/scores/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('scores')
    .delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ============================================================
// DRAWS
// ============================================================

// GET /api/draws — all published draws (public)
app.get('/api/draws', async (req, res) => {
  const { data, error } = await supabase
    .from('draws').select('*')
    .eq('status', 'published')
    .order('draw_month', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ draws: data });
});

// GET /api/draws/current — latest published draw
app.get('/api/draws/current', async (req, res) => {
  const { data, error } = await supabase
    .from('draws').select('*').eq('status', 'published')
    .order('draw_month', { ascending: false }).limit(1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ draw: data });
});

// POST /api/admin/draws — create/configure draw (admin)
app.post('/api/admin/draws', requireAdmin, async (req, res) => {
  const { draw_month, logic_type = 'random' } = req.body;

  // Calculate prize pool from active subscribers
  const { data: subCount } = await supabase
    .rpc('get_active_subscriber_counts');

  const monthly = subCount?.monthly_count || 0;
  const yearly  = subCount?.yearly_count  || 0;
  const prizePool = parseFloat(((monthly * 9.00) + (yearly * 8.25)).toFixed(2));

  // Check for jackpot rollover from previous month
  const prevDate = new Date(draw_month);
  prevDate.setMonth(prevDate.getMonth() - 1);
  const { data: prevDraw } = await supabase
    .from('draws').select('jackpot_gbp, jackpot_rolled')
    .eq('draw_month', prevDate.toISOString().slice(0,10))
    .single();

  const rolloverJackpot = prevDraw?.jackpot_rolled ? prevDraw.jackpot_gbp : 0;

  const { data, error } = await supabase.from('draws').insert({
    draw_month, logic_type,
    prize_pool_gbp: prizePool + rolloverJackpot,
    status: 'pending'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ draw: data });
});

// POST /api/admin/draws/:id/simulate — generate numbers without publishing
app.post('/api/admin/draws/:id/simulate', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: draw, error: fetchErr } = await supabase
    .from('draws').select('*').eq('id', id).single();
  if (fetchErr || !draw) return res.status(404).json({ error: 'Draw not found' });

  let numbers;
  if (draw.logic_type === 'weighted') {
    numbers = await generateWeightedNumbers();
  } else {
    numbers = generateRandomNumbers();
  }

  const { data, error } = await supabase.from('draws').update({
    drawn_numbers: numbers, status: 'simulated'
  }).eq('id', id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ draw: data, numbers });
});

// POST /api/admin/draws/:id/publish — publish draw & compute winners
app.post('/api/admin/draws/:id/publish', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: draw } = await supabase.from('draws').select('*').eq('id', id).single();
  if (!draw) return res.status(404).json({ error: 'Draw not found' });
  if (!draw.drawn_numbers?.length)
    return res.status(400).json({ error: 'Run simulation first' });

  const drawn = draw.drawn_numbers;

  // Get all active subscriber scores for this draw
  const { data: entries } = await supabase
    .from('subscriptions').select('user_id').eq('status','active');

  let jackpotWinners = [], secondWinners = [], thirdWinners = [];
  const entryRecords = [];

  for (const { user_id } of entries) {
    const { data: userScores } = await supabase
      .from('scores').select('score')
      .eq('user_id', user_id)
      .order('played_date', { ascending: false })
      .limit(5);

    const scores = userScores?.map(s => s.score) || [];
    if (scores.length === 0) continue;

    const matchCount = scores.filter(s => drawn.includes(s)).length;
    let tier = null;
    if (matchCount === 5) { tier = 'jackpot';  jackpotWinners.push(user_id); }
    else if (matchCount === 4) { tier = 'second'; secondWinners.push(user_id); }
    else if (matchCount === 3) { tier = 'third';  thirdWinners.push(user_id); }

    entryRecords.push({
      draw_id: id, user_id, scores_used: scores, match_count: matchCount, prize_tier: tier
    });
  }

  // Batch insert entries
  if (entryRecords.length) {
    await supabase.from('draw_entries').insert(entryRecords);
  }

  // Handle jackpot rollover
  const jackpotRolled = jackpotWinners.length === 0;

  // Create winner records with split prizes
  const winnerInserts = [];

  if (!jackpotRolled && jackpotWinners.length > 0) {
    const perWinner = parseFloat((draw.jackpot_gbp / jackpotWinners.length).toFixed(2));
    jackpotWinners.forEach(uid => winnerInserts.push({
      draw_id: id, user_id: uid, prize_tier: 'jackpot',
      prize_amount_gbp: perWinner, match_count: 5
    }));
  }

  if (secondWinners.length > 0) {
    const perWinner = parseFloat((draw.second_prize_gbp / secondWinners.length).toFixed(2));
    secondWinners.forEach(uid => winnerInserts.push({
      draw_id: id, user_id: uid, prize_tier: 'second',
      prize_amount_gbp: perWinner, match_count: 4
    }));
  }

  if (thirdWinners.length > 0) {
    const perWinner = parseFloat((draw.third_prize_gbp / thirdWinners.length).toFixed(2));
    thirdWinners.forEach(uid => winnerInserts.push({
      draw_id: id, user_id: uid, prize_tier: 'third',
      prize_amount_gbp: perWinner, match_count: 3
    }));
  }

  if (winnerInserts.length) {
    await supabase.from('winners').insert(winnerInserts);
  }

  // Publish draw
  await supabase.from('draws').update({
    status: 'published',
    jackpot_rolled: jackpotRolled,
    published_at: new Date()
  }).eq('id', id);

  // Notify all subscribers
  await notifyDrawResults(id, drawn, jackpotRolled);

  res.json({
    success: true,
    jackpotWinners: jackpotWinners.length,
    secondWinners:  secondWinners.length,
    thirdWinners:   thirdWinners.length,
    jackpotRolled
  });
});

// ============================================================
// WINNERS / VERIFICATION
// ============================================================

// GET /api/admin/winners/pending
app.get('/api/admin/winners/pending', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('pending_winners').select('*');       // uses VIEW
  if (error) return res.status(500).json({ error: error.message });
  res.json({ winners: data });
});

// POST /api/winners/:id/proof — winner uploads screenshot proof
app.post('/api/winners/:id/proof', requireAuth, async (req, res) => {
  const { proof_url } = req.body;
  const { data, error } = await supabase.from('winners')
    .update({ proof_url })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .eq('verify_status', 'pending')
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ winner: data });
});

// PATCH /api/admin/winners/:id/verify
app.patch('/api/admin/winners/:id/verify', requireAdmin, async (req, res) => {
  const { action, notes } = req.body; // action: 'approve' | 'reject'
  if (!['approve','reject'].includes(action))
    return res.status(400).json({ error: 'action must be approve or reject' });

  const updateData = {
    verify_status: action === 'approve' ? 'approved' : 'rejected',
    verified_by: req.user.id,
    verified_at: new Date(),
    notes
  };

  const { data, error } = await supabase.from('winners')
    .update(updateData).eq('id', req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Notify winner
  if (action === 'approve') {
    await sendNotification(data.user_id, 'winner_alert', {
      prize_amount: data.prize_amount_gbp, prize_tier: data.prize_tier
    });
  }

  res.json({ winner: data });
});

// PATCH /api/admin/winners/:id/paid
app.patch('/api/admin/winners/:id/paid', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('winners')
    .update({ payment_status: 'paid', paid_at: new Date() })
    .eq('id', req.params.id).eq('verify_status','approved')
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await sendNotification(data.user_id, 'payout_confirmed', {
    prize_amount: data.prize_amount_gbp
  });

  res.json({ winner: data });
});

// ============================================================
// CHARITIES
// ============================================================

// GET /api/charities
app.get('/api/charities', async (req, res) => {
  const { data, error } = await supabase
    .from('charities').select('*').eq('is_active', true)
    .order('total_raised', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ charities: data });
});

// POST /api/admin/charities
app.post('/api/admin/charities', requireAdmin, async (req, res) => {
  const { name, description, emoji, website_url, is_featured } = req.body;
  const { data, error } = await supabase.from('charities')
    .insert({ name, description, emoji, website_url, is_featured: !!is_featured })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ charity: data });
});

// PATCH /api/admin/charities/:id
app.patch('/api/admin/charities/:id', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('charities')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ charity: data });
});

// DELETE /api/admin/charities/:id (soft delete)
app.delete('/api/admin/charities/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('charities')
    .update({ is_active: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PATCH /api/profile/charity — user updates their charity selection
app.patch('/api/profile/charity', requireAuth, async (req, res) => {
  const { charity_id, charity_pct } = req.body;
  const pct = Math.max(10, Math.min(100, parseFloat(charity_pct || 10)));
  const { data, error } = await supabase.from('profiles')
    .update({ charity_id, charity_pct: pct }).eq('id', req.user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

// ============================================================
// USER DASHBOARD
// ============================================================

// GET /api/dashboard
app.get('/api/dashboard', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('user_dashboard').select('*').eq('id', req.user.id).single();
  if (error) return res.status(500).json({ error: error.message });

  // Also fetch draw history
  const { data: entries } = await supabase
    .from('draw_entries')
    .select(`*, draws(draw_month, drawn_numbers, status)`)
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(12);

  res.json({ dashboard: data, drawHistory: entries });
});

// ============================================================
// ADMIN — USERS & SUBSCRIPTIONS
// ============================================================

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { search, status, page = 1, limit = 50 } = req.query;
  let query = supabase.from('profiles')
    .select(`*, subscriptions(plan, status, amount_gbp, current_period_end)`,
            { count: 'exact' });

  if (search) query = query.ilike('full_name', `%${search}%`);

  const from = (page - 1) * limit;
  query = query.range(from, from + limit - 1);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// PATCH /api/admin/users/:id
app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const allowed = ['full_name','charity_id','charity_pct','role'];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  const { data, error } = await supabase.from('profiles')
    .update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

// ============================================================
// ADMIN — ANALYTICS
// ============================================================

// GET /api/admin/analytics
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
  const [
    { data: subCount },
    { data: revenue },
    { data: charityTotals },
    { data: drawStats }
  ] = await Promise.all([
    supabase.rpc('get_active_subscriber_counts'),
    supabase.from('subscriptions')
      .select('plan, amount_gbp, created_at')
      .eq('status','active'),
    supabase.from('charity_donations')
      .select('charity_id, amount_gbp, charities(name)')
      .order('amount_gbp', { ascending: false }),
    supabase.from('draws')
      .select('*').eq('status','published')
      .order('draw_month', { ascending: false })
      .limit(12)
  ]);

  res.json({ subCount, revenue, charityTotals, drawStats });
});

// ============================================================
// DRAW HELPERS
// ============================================================

function generateRandomNumbers() {
  const nums = new Set();
  while (nums.size < 5) nums.add(Math.floor(Math.random() * 45) + 1);
  return Array.from(nums);
}

async function generateWeightedNumbers() {
  // Weighted by most frequent scores across all users (inverse — least common = harder to match)
  const { data: allScores } = await supabase
    .from('scores').select('score');

  const freq = {};
  allScores?.forEach(({ score }) => { freq[score] = (freq[score] || 0) + 1; });

  // Build weighted pool (higher freq = higher chance)
  const pool = [];
  for (let n = 1; n <= 45; n++) {
    const weight = freq[n] || 1;
    for (let w = 0; w < weight; w++) pool.push(n);
  }

  // Shuffle and pick 5 unique
  const drawn = new Set();
  const shuffled = pool.sort(() => Math.random() - 0.5);
  for (const n of shuffled) {
    if (drawn.size === 5) break;
    drawn.add(n);
  }
  return Array.from(drawn);
}

// ============================================================
// EMAIL HELPERS
// ============================================================

async function sendNotification(userId, type, meta = {}) {
  await supabase.from('notifications').insert({
    user_id: userId, type, meta, status: 'queued'
  });
}

async function notifyDrawResults(drawId, numbers, jackpotRolled) {
  // Queue email for every active subscriber
  const { data: subs } = await supabase
    .from('subscriptions').select('user_id').eq('status','active');

  const inserts = subs.map(({ user_id }) => ({
    user_id, type: 'draw_result',
    subject: 'March 2026 Draw Results are in! 🎲',
    status: 'queued',
    meta: { numbers, jackpotRolled, drawId }
  }));

  await supabase.from('notifications').insert(inserts);
}

// Process queued notifications (cron job target)
app.post('/api/internal/send-notifications', async (req, res) => {
  const { data: queued } = await supabase
    .from('notifications').select('*, profiles(email, full_name)')
    .eq('status','queued').limit(50);

  let sent = 0;
  for (const notif of queued || []) {
    try {
      const html = buildEmailHtml(notif.type, notif.meta, notif.profiles?.full_name);
      await mailer.sendMail({
        from: '"Par & Purpose" <hello@parpose.co>',
        to: notif.profiles?.email,
        subject: notif.subject || 'Update from Par & Purpose',
        html
      });
      await supabase.from('notifications').update({ status: 'sent', sent_at: new Date() }).eq('id', notif.id);
      sent++;
    } catch (err) {
      await supabase.from('notifications').update({ status: 'failed' }).eq('id', notif.id);
    }
  }
  res.json({ sent });
});

function buildEmailHtml(type, meta, name = 'Member') {
  const greet = `<p>Hi ${name},</p>`;
  switch (type) {
    case 'welcome':
      return `${greet}<p>Welcome to Par & Purpose! Your ${meta.plan} subscription is active. Start entering scores on your dashboard.</p>`;
    case 'draw_result':
      return `${greet}<p>The ${meta.numbers?.join(', ')} draw is live. ${meta.jackpotRolled ? 'No jackpot winner — it rolls to next month!' : 'A jackpot winner was found!'} Check your dashboard for results.</p>`;
    case 'winner_alert':
      return `${greet}<p>🏆 Congratulations! You won £${meta.prize_amount} (${meta.prize_tier}). Upload your proof to claim your prize.</p>`;
    case 'payout_confirmed':
      return `${greet}<p>💸 Your payout of £${meta.prize_amount} has been processed. Check your bank account within 3–5 working days.</p>`;
    default:
      return `${greet}<p>Update from Par & Purpose.</p>`;
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date() }));

// ============================================================
// START
// ============================================================
app.listen(PORT, () => console.log(`🚀 Par & Purpose API running on port ${PORT}`));

export default app;
