CREATE TABLE IF NOT EXISTS settings (id boolean PRIMARY KEY DEFAULT true CHECK(id), data jsonb NOT NULL);
INSERT INTO settings(id,data) VALUES(true,'{"roomCapacity":12,"tables":[{"id":"table-2","name":"Tavolo 2","seats":2},{"id":"table-4","name":"Tavolo 4","seats":4},{"id":"table-6","name":"Tavolo 6","seats":6}],"openingDays":[0,2,3,4,5,6],"openTime":"18:00","closeTime":"24:00","slotMinutes":120}') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS games (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bookings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL,
 participants jsonb NOT NULL CHECK(jsonb_typeof(participants)='array' AND jsonb_array_length(participants) BETWEEN 1 AND 6),
 table_id text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL CHECK(end_at>start_at),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','cancelled')),
 token_hash text UNIQUE NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_active_time ON bookings(start_at,end_at) WHERE status IN ('pending','confirmed');
CREATE TABLE IF NOT EXISTS outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payload text, attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_attempt_at) WHERE sent_at IS NULL;
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
-- Dedicated runtime role is intentionally not an owner and cannot bypass RLS.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ludoteca_app') THEN CREATE ROLE ludoteca_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $$;
REVOKE ALL ON settings,games,bookings,outbox,rate_limits FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ludoteca_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON settings,games,bookings,outbox,rate_limits TO ludoteca_app;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_only ON settings TO ludoteca_app USING(true) WITH CHECK(true);
CREATE POLICY server_only ON games TO ludoteca_app USING(true) WITH CHECK(true);
CREATE POLICY server_only ON bookings TO ludoteca_app USING(true) WITH CHECK(true);
CREATE POLICY server_only ON outbox TO ludoteca_app USING(true) WITH CHECK(true);
CREATE POLICY server_only ON rate_limits TO ludoteca_app USING(true) WITH CHECK(true);
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON settings,games,bookings,outbox,rate_limits FROM %I',r); END IF; END LOOP; END $$;
