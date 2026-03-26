-- ============================================================
-- Par & Purpose · Golf Charity Subscription Platform
-- Supabase / PostgreSQL Schema
-- Version: 1.0 · March 2026
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. USERS / PROFILES
-- ============================================================
CREATE TABLE profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name       TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL DEFAULT 'subscriber' CHECK (role IN ('subscriber','admin')),
  charity_id      UUID,                         -- FK added after charities table
  charity_pct     NUMERIC(5,2) NOT NULL DEFAULT 10.00 CHECK (charity_pct >= 10 AND charity_pct <= 100),
  avatar_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

CREATE TRIGGER profiles_updated BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 2. CHARITIES
-- ============================================================
CREATE TABLE charities (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  description     TEXT,
  emoji           TEXT DEFAULT '🌿',
  image_url       TEXT,
  website_url     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_featured     BOOLEAN NOT NULL DEFAULT FALSE,
  total_raised    NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  subscriber_count INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER charities_updated BEFORE UPDATE ON charities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Add FK now that charities table exists
ALTER TABLE profiles
  ADD CONSTRAINT profiles_charity_fk
  FOREIGN KEY (charity_id) REFERENCES charities(id) ON DELETE SET NULL;

-- ============================================================
-- 3. SUBSCRIPTIONS
-- ============================================================
CREATE TABLE subscriptions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan                TEXT NOT NULL CHECK (plan IN ('monthly','yearly')),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','lapsed','cancelled','cancelling','past_due')),
  stripe_customer_id  TEXT,
  stripe_sub_id       TEXT UNIQUE,
  amount_gbp          NUMERIC(8,2) NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)    -- one active subscription per user
);

CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 4. SCORES  (rolling 5)
-- ============================================================
CREATE TABLE scores (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  score       INT NOT NULL CHECK (score >= 1 AND score <= 45),
  played_date DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast user score lookups
CREATE INDEX scores_user_date_idx ON scores (user_id, played_date DESC);

-- Function: enforce rolling 5 — delete oldest when 6th added
CREATE OR REPLACE FUNCTION enforce_rolling_scores()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  score_count INT;
  oldest_id   UUID;
BEGIN
  SELECT COUNT(*) INTO score_count FROM scores WHERE user_id = NEW.user_id;
  IF score_count >= 5 THEN
    SELECT id INTO oldest_id
      FROM scores
      WHERE user_id = NEW.user_id
      ORDER BY played_date ASC, created_at ASC
      LIMIT 1;
    DELETE FROM scores WHERE id = oldest_id;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER rolling_scores_trigger
  BEFORE INSERT ON scores
  FOR EACH ROW EXECUTE FUNCTION enforce_rolling_scores();

-- View: latest 5 scores per user
CREATE OR REPLACE VIEW user_scores_latest AS
  SELECT
    s.*,
    p.full_name,
    ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY s.played_date DESC, s.created_at DESC) AS score_rank
  FROM scores s
  JOIN profiles p ON p.id = s.user_id;

-- ============================================================
-- 5. DRAWS
-- ============================================================
CREATE TABLE draws (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  draw_month      DATE NOT NULL UNIQUE,          -- e.g. 2026-03-01 = March 2026
  logic_type      TEXT NOT NULL DEFAULT 'random' CHECK (logic_type IN ('random','weighted')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','simulated','published')),
  drawn_numbers   INT[] NOT NULL DEFAULT '{}',   -- array of 5 integers 1–45
  prize_pool_gbp  NUMERIC(12,2) NOT NULL DEFAULT 0,
  jackpot_gbp     NUMERIC(12,2) NOT NULL DEFAULT 0,
  second_prize_gbp NUMERIC(12,2) NOT NULL DEFAULT 0,
  third_prize_gbp  NUMERIC(12,2) NOT NULL DEFAULT 0,
  jackpot_rolled  BOOLEAN NOT NULL DEFAULT FALSE, -- true = no 5-match, carry forward
  notes           TEXT,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER draws_updated BEFORE UPDATE ON draws
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Function: auto-calculate prize pool tiers
CREATE OR REPLACE FUNCTION calc_prize_pool()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.jackpot_gbp      := ROUND(NEW.prize_pool_gbp * 0.40, 2);
  NEW.second_prize_gbp := ROUND(NEW.prize_pool_gbp * 0.35, 2);
  NEW.third_prize_gbp  := ROUND(NEW.prize_pool_gbp * 0.25, 2);
  RETURN NEW;
END; $$;

CREATE TRIGGER draws_calc_pool
  BEFORE INSERT OR UPDATE OF prize_pool_gbp ON draws
  FOR EACH ROW EXECUTE FUNCTION calc_prize_pool();

-- ============================================================
-- 6. DRAW ENTRIES  (which scores entered which draw)
-- ============================================================
CREATE TABLE draw_entries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  draw_id     UUID NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scores_used INT[] NOT NULL,       -- snapshot of the 5 scores at draw time
  match_count INT,                  -- 0-5, computed after draw
  prize_tier  TEXT CHECK (prize_tier IN ('jackpot','second','third',NULL)),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (draw_id, user_id)
);

CREATE INDEX draw_entries_draw_idx ON draw_entries(draw_id);
CREATE INDEX draw_entries_user_idx ON draw_entries(user_id);

-- ============================================================
-- 7. WINNERS & VERIFICATION
-- ============================================================
CREATE TABLE winners (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  draw_id         UUID NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entry_id        UUID REFERENCES draw_entries(id),
  prize_tier      TEXT NOT NULL CHECK (prize_tier IN ('jackpot','second','third')),
  prize_amount_gbp NUMERIC(10,2) NOT NULL,
  match_count     INT NOT NULL CHECK (match_count BETWEEN 3 AND 5),
  proof_url       TEXT,             -- screenshot uploaded by winner
  verify_status   TEXT NOT NULL DEFAULT 'pending'
                    CHECK (verify_status IN ('pending','approved','rejected')),
  payment_status  TEXT NOT NULL DEFAULT 'pending'
                    CHECK (payment_status IN ('pending','paid')),
  verified_by     UUID REFERENCES profiles(id),
  verified_at     TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER winners_updated BEFORE UPDATE ON winners
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 8. CHARITY DONATIONS  (transaction ledger)
-- ============================================================
CREATE TABLE charity_donations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  charity_id      UUID NOT NULL REFERENCES charities(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id),
  amount_gbp      NUMERIC(8,2) NOT NULL,
  donation_type   TEXT NOT NULL DEFAULT 'subscription'
                    CHECK (donation_type IN ('subscription','independent')),
  period_start    DATE,
  period_end      DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX donations_charity_idx ON charity_donations(charity_id);
CREATE INDEX donations_user_idx    ON charity_donations(user_id);

-- Auto-update charity total_raised when donation inserted
CREATE OR REPLACE FUNCTION update_charity_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE charities SET
    total_raised     = total_raised + NEW.amount_gbp,
    subscriber_count = (SELECT COUNT(DISTINCT user_id) FROM charity_donations WHERE charity_id = NEW.charity_id)
  WHERE id = NEW.charity_id;
  RETURN NEW;
END; $$;

CREATE TRIGGER donation_charity_totals
  AFTER INSERT ON charity_donations
  FOR EACH ROW EXECUTE FUNCTION update_charity_totals();

-- ============================================================
-- 9. EMAIL NOTIFICATIONS LOG
-- ============================================================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'welcome','draw_result','winner_alert','payment_receipt',
                'subscription_renewal','subscription_lapsed','payout_confirmed'
              )),
  subject     TEXT,
  sent_at     TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 10. AUDIT LOG
-- ============================================================
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  table_name  TEXT,
  record_id   UUID,
  old_data    JSONB,
  new_data    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores           ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE draw_entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE winners          ENABLE ROW LEVEL SECURITY;
ALTER TABLE charity_donations ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications    ENABLE ROW LEVEL SECURITY;

-- Profiles: users see/edit only their own; admins see all
CREATE POLICY profiles_self ON profiles
  FOR ALL USING (auth.uid() = id OR EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- Scores: users manage only their own
CREATE POLICY scores_self ON scores
  FOR ALL USING (auth.uid() = user_id OR EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- Subscriptions: self + admin
CREATE POLICY subs_self ON subscriptions
  FOR ALL USING (auth.uid() = user_id OR EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- Draw entries: self + admin
CREATE POLICY entries_self ON draw_entries
  FOR ALL USING (auth.uid() = user_id OR EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- Winners: self can read; admin manages
CREATE POLICY winners_read ON winners
  FOR SELECT USING (auth.uid() = user_id OR EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- Charities: public read, admin write
CREATE POLICY charities_public_read ON charities FOR SELECT USING (is_active = TRUE);
CREATE POLICY charities_admin_write ON charities FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Draws: public read published; admin manages all
CREATE POLICY draws_public_read ON draws FOR SELECT USING (status = 'published');
CREATE POLICY draws_admin_all ON draws FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- ============================================================
-- SEED DATA
-- ============================================================
INSERT INTO charities (name, description, emoji, is_active, is_featured) VALUES
  ('Trees for Cities',   'Planting trees in urban areas to improve city environments.', '🌿', TRUE,  TRUE),
  ('Golf for Health',    'Golf therapy for mental health and rehabilitation across the UK.', '🏥', TRUE,  FALSE),
  ('Caddie Foundation',  'Supporting families of golf caddies in low-income communities.', '🎗️', TRUE,  FALSE),
  ('Water & Fairways',   'Clean water access in regions affected by golf development.', '🌍', TRUE,  FALSE);

-- ============================================================
-- USEFUL VIEWS & QUERIES
-- ============================================================

-- Active subscriber count (for prize pool calculation)
CREATE OR REPLACE VIEW active_subscriber_count AS
  SELECT COUNT(*) AS total,
    SUM(CASE WHEN plan = 'monthly' THEN 1 ELSE 0 END) AS monthly_count,
    SUM(CASE WHEN plan = 'yearly'  THEN 1 ELSE 0 END) AS yearly_count
  FROM subscriptions WHERE status = 'active';

-- Monthly prize pool estimate
CREATE OR REPLACE VIEW estimated_prize_pool AS
  SELECT
    (monthly_count * 9.00 + yearly_count * 8.25) AS monthly_revenue,
    ROUND((monthly_count * 9.00 + yearly_count * 8.25) * 0.40, 2) AS pool_40pct,
    ROUND((monthly_count * 9.00 + yearly_count * 8.25) * 0.35, 2) AS pool_35pct,
    ROUND((monthly_count * 9.00 + yearly_count * 8.25) * 0.25, 2) AS pool_25pct
  FROM active_subscriber_count;

-- Winners pending verification
CREATE OR REPLACE VIEW pending_winners AS
  SELECT w.*, p.full_name, p.email, d.draw_month, d.drawn_numbers
  FROM winners w
  JOIN profiles p ON p.id = w.user_id
  JOIN draws d ON d.id = w.draw_id
  WHERE w.verify_status = 'pending'
  ORDER BY w.created_at ASC;

-- User dashboard summary
CREATE OR REPLACE VIEW user_dashboard AS
  SELECT
    p.id,
    p.full_name,
    p.charity_pct,
    c.name AS charity_name,
    s.plan,
    s.status AS sub_status,
    s.current_period_end,
    s.amount_gbp,
    COALESCE((SELECT SUM(prize_amount_gbp) FROM winners WHERE user_id = p.id AND payment_status = 'paid'), 0) AS total_winnings,
    COALESCE((SELECT SUM(amount_gbp) FROM charity_donations WHERE user_id = p.id), 0) AS total_donated,
    (SELECT COUNT(*) FROM draw_entries WHERE user_id = p.id) AS draws_entered
  FROM profiles p
  LEFT JOIN subscriptions s ON s.user_id = p.id
  LEFT JOIN charities c ON c.id = p.charity_id;
