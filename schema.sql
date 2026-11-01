-- Runs on every server start; safe to run more than once.

CREATE TABLE IF NOT EXISTS games (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  html        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row = one attempt (one play of one game by one student).
CREATE TABLE IF NOT EXISTS results (
  id          SERIAL PRIMARY KEY,
  game_id     INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  grade       TEXT NOT NULL,
  section     TEXT NOT NULL,
  student_key TEXT NOT NULL,                     -- normalized name|grade|section
  attempt_no  INT  NOT NULL,                     -- 1, 2, 3... per game + student
  token       TEXT NOT NULL,                     -- secret the student's browser uses to save this attempt
  status      TEXT NOT NULL DEFAULT 'started',   -- started | completed | not_finished
  score       DOUBLE PRECISION,
  max_score   DOUBLE PRECISION,
  duration_s  INT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS results_game_created ON results (game_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS results_attempt ON results (game_id, student_key, attempt_no);
