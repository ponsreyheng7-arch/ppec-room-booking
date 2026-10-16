
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone varchar(32) NOT NULL UNIQUE,
  full_name varchar(160) NOT NULL,
  email varchar(254),
  role varchar(24) NOT NULL CHECK (
    role IN ('admin', 'internal_doctor', 'external_doctor')
  ),
  password_hash text NOT NULL,
  password_change_required boolean NOT NULL DEFAULT false,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'suspended', 'inactive')
  ),
  last_login_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  doctor_code varchar(40) NOT NULL UNIQUE,
  doctor_type varchar(16) NOT NULL CHECK (
    doctor_type IN ('internal', 'external')
  ),
  profile_photo_url text,
  medical_license_number varchar(100),
  licensing_authority varchar(160),
  workplace varchar(200),
  approved_surgery_types uuid[],
  commission_percentage numeric(5,2) NOT NULL DEFAULT 0 CHECK (
    commission_percentage BETWEEN 0 AND 100
  ),
  payment_method varchar(40),
  payment_account_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS surgery_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL UNIQUE,
  default_duration_minutes integer NOT NULL CHECK (
    default_duration_minutes > 0
    AND default_duration_minutes % 30 = 0
  ),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operating_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL UNIQUE,
  display_name varchar(80) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operating_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  session_name varchar(24) NOT NULL CHECK (
    session_name IN ('morning', 'afternoon')
  ),
  start_time time NOT NULL,
  end_time time NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (end_time > start_time),
  UNIQUE (weekday, session_name)
);

CREATE TABLE IF NOT EXISTS blocked_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(160) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  operating_room_id uuid REFERENCES operating_rooms(id),
  reason text,
  created_by uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ppec_patient_id varchar(80),
  full_name varchar(180) NOT NULL,
  phone varchar(40) NOT NULL,
  external_record_url text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS patients_ppec_id_idx
  ON patients(ppec_patient_id);

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_code varchar(32) NOT NULL UNIQUE,
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  surgery_type_id uuid NOT NULL REFERENCES surgery_types(id),
  operating_room_id uuid NOT NULL REFERENCES operating_rooms(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'confirmed' CHECK (
    status IN (
      'confirmed',
      'completed',
      'cancelled',
      'rescheduled',
      'no_show'
    )
  ),
  operated_eye varchar(2) NOT NULL DEFAULT 'RE' CHECK (
    operated_eye IN ('RE', 'LE', 'BE')
  ),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  cancellation_reason text,
  override_reason text,
  rescheduled_to uuid REFERENCES bookings(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  EXCLUDE USING gist (
    operating_room_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  )
  WHERE (status NOT IN ('cancelled', 'rescheduled'))
);

CREATE INDEX IF NOT EXISTS bookings_start_at_idx
  ON bookings(start_at);

CREATE INDEX IF NOT EXISTS bookings_doctor_start_idx
  ON bookings(doctor_id, start_at);

CREATE INDEX IF NOT EXISTS bookings_status_idx
  ON bookings(status);

CREATE TABLE IF NOT EXISTS surgery_financials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  patient_reference varchar(100),
  surgery_type_name varchar(120) NOT NULL,
  completed_on date NOT NULL,
  eligible_surgery_fee numeric(12,2) NOT NULL CHECK (
    eligible_surgery_fee >= 0
  ),
  commission_percentage_snapshot numeric(5,2) NOT NULL CHECK (
    commission_percentage_snapshot BETWEEN 0 AND 100
  ),
  commission_amount numeric(12,2) NOT NULL CHECK (
    commission_amount >= 0
  ),
  adjustment_amount numeric(12,2) NOT NULL DEFAULT 0,
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS surgery_financials_doctor_date_idx
  ON surgery_financials(doctor_id, completed_on);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_code varchar(32) NOT NULL UNIQUE,
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method varchar(40) NOT NULL,
  paid_on date NOT NULL,
  payment_reference varchar(160),
  notes text,
  status varchar(20) NOT NULL DEFAULT 'recorded' CHECK (
    status IN ('recorded', 'reversed')
  ),
  reversed_reason text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_doctor_paid_idx
  ON payments(doctor_id, paid_on);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  surgery_financial_id uuid NOT NULL REFERENCES surgery_financials(id),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, surgery_financial_id)
);

CREATE INDEX IF NOT EXISTS payment_allocations_financial_idx
  ON payment_allocations(surgery_financial_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  action varchar(100) NOT NULL,
  entity_type varchar(60) NOT NULL,
  entity_id varchar(100),
  reason text,
  ip_address inet,
  user_agent text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx
  ON audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS audit_logs_entity_idx
  ON audit_logs(entity_type, entity_id);

-- Seed operating rooms.
INSERT INTO operating_rooms (code, display_name)
VALUES
  ('A', 'Bed A — Zeiss'),
  ('B', 'Bed B — Leica')
ON CONFLICT (code) DO NOTHING;

-- Seed surgery types.
INSERT INTO surgery_types (name, default_duration_minutes)
VALUES
  ('Pterygium surgery', 30),
  ('Cataract surgery', 60),
  ('Eyelid surgery', 60),
  ('Other surgery — 30 minutes', 30),
  ('Other surgery — 60 minutes', 60)
ON CONFLICT (name) DO NOTHING;

-- Sunday = 0, Monday = 1 ... Saturday = 6.
-- Seed Monday through Saturday operating sessions.
INSERT INTO operating_hours (
  weekday,
  session_name,
  start_time,
  end_time
)
SELECT
  d.weekday,
  s.session_name,
  s.start_time::time,
  e.end_time::time
FROM generate_series(1, 6) AS d(weekday)
CROSS JOIN (
  VALUES
    ('morning', '08:00'),
    ('afternoon', '14:00')
) AS s(session_name, start_time)
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN s.session_name = 'morning' THEN '11:00'
    ELSE '17:00'
  END AS end_time
) AS e
ON CONFLICT (weekday, session_name) DO NOTHING;

COMMIT;
