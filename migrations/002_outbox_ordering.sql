ALTER TABLE outbox ADD COLUMN booking_id uuid REFERENCES bookings(id) ON DELETE RESTRICT;
CREATE SEQUENCE outbox_sequence_no_seq;
ALTER TABLE outbox ADD COLUMN sequence_no bigint;
-- Existing encrypted messages have no recoverable SQL booking association.
-- Keep them intact in a globally ordered legacy lane; never discard the initial link.
WITH ordered AS (
 SELECT id,row_number() OVER (ORDER BY created_at,id) AS sequence_no FROM outbox
)
UPDATE outbox SET sequence_no=ordered.sequence_no FROM ordered WHERE outbox.id=ordered.id;
SELECT setval('outbox_sequence_no_seq',COALESCE(max(sequence_no),0)+1,false) FROM outbox;
ALTER TABLE outbox ALTER COLUMN sequence_no SET DEFAULT nextval('outbox_sequence_no_seq');
ALTER TABLE outbox ALTER COLUMN sequence_no SET NOT NULL;
ALTER SEQUENCE outbox_sequence_no_seq OWNED BY outbox.sequence_no;
CREATE UNIQUE INDEX outbox_sequence_no_unique ON outbox(sequence_no);
CREATE INDEX outbox_booking_unsent ON outbox(booking_id,sequence_no) WHERE sent_at IS NULL;
REVOKE ALL ON SEQUENCE outbox_sequence_no_seq FROM PUBLIC;
GRANT USAGE ON SEQUENCE outbox_sequence_no_seq TO ludoteca_app;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON SEQUENCE outbox_sequence_no_seq FROM %I',r); END IF; END LOOP; END $$;
