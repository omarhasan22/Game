// Game Hub: teachers upload HTML games, students play them at /<slug>,
// and every attempt is saved for the results dashboard.
import express from 'express';
import cookieSession from 'cookie-session';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch { /* no .env file: use real environment variables */ }
const { query, exec, dbKind } = await import('./db.js');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = !!process.env.RENDER || process.env.NODE_ENV === 'production';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Add it to .env (local) or the Render dashboard.');
  process.exit(1);
}
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set; the teacher will be logged out whenever the server restarts.');
}

// Paths that can never be a game slug.
const RESERVED = new Set(['admin', 'api', 'play', 'sdk.js', 'assets', 'static', 'health', 'login', 'logout', 'favicon.ico', 'robots.txt']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock allow-downloads';

/* ---------- helpers ---------- */

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const studentKey = (name, grade, section) => [name, grade, section].map(s => s.toLowerCase()).join('|');
const num = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function validateSlug(raw) {
  const slug = String(raw ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw httpError(400, 'Link name must be 1–40 characters: lowercase letters, numbers and dashes (not at the start or end).');
  if (RESERVED.has(slug)) throw httpError(400, `"${slug}" is reserved. Please choose another link name.`);
  return slug;
}

function readUpload(file) {
  if (!file) return null;
  if (!/\.html?$/i.test(file.originalname)) throw httpError(400, 'Please upload an .html file.');
  const html = file.buffer.toString('utf8').replace(/^﻿/, '');
  if (!/<(html|head|body|script|div|canvas)\b/i.test(html)) throw httpError(400, 'That file does not look like an HTML game.');
  return html;
}

function titleFromHtml(html, fallback) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return clean(m ? m[1] : fallback, 120) || fallback;
}

// Put the SDK inline at the top of the page so games can use GameHub (and the storage shim) right away.
const SDK_TAG = '<script>' + fs.readFileSync(path.join(PUBLIC, 'sdk.js'), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>';
function injectSdk(html) {
  const tag = SDK_TAG;
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /^\s*<!doctype[^>]*>/i]) {
    const m = html.match(re);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
  }
  return tag + html;
}

function parseResult(data) {
  const d = data && typeof data === 'object' ? data : {};
  const s = String(d.status || '').toLowerCase().replace(/[\s-]+/g, '_');
  const status = ['not_finished', 'incomplete', 'unfinished', 'failed', 'timeout'].includes(s) ? 'not_finished' : 'completed';
  let duration = num(d.duration_s ?? d.duration ?? d.time_s);
  duration = duration == null || duration < 0 ? null : Math.min(Math.round(duration), 7 * 86400);
  let details = d.details && typeof d.details === 'object' ? d.details : null;
  if (!details) {
    const { status: _s, score, max_score, duration_s, duration, time_s, ...rest } = d;
    details = Object.keys(rest).length ? rest : null;
  }
  let json = details ? JSON.stringify(details) : null;
  if (json && json.length > 20000) json = JSON.stringify({ note: 'details too large to store' });
  return { status, score: num(d.score), max_score: num(d.max_score ?? d.maxScore), duration_s: duration, details: json };
}

async function createAttempt(gameId, student) {
  const token = crypto.randomBytes(16).toString('hex');
  for (let i = 0; ; i++) {
    try {
      const { rows } = await query(
        `INSERT INTO results (game_id, full_name, grade, section, student_key, attempt_no, token)
         VALUES ($1, $2, $3, $4, $5,
                 (SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM results WHERE game_id = $1 AND student_key = $5),
                 $6)
         RETURNING id, attempt_no, token`,
        [gameId, student.full_name, student.grade, student.section, student.student_key, token]);
      return rows[0];
    } catch (e) {
      // Two attempts started at the same moment got the same number: try again.
      if (e.code !== '23505' || i >= 5) throw e;
    }
  }
}

function resultFilters(q) {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  if (q.game) add('g.slug = ?', String(q.game));
  if (q.grade) add('lower(r.grade) = lower(?)', String(q.grade));
  if (q.section) add('lower(r.section) = lower(?)', String(q.section));
  if (q.status) add('r.status = ?', String(q.status));
  if (q.student) add('r.student_key = ?', String(q.student));
  if (q.q) add("r.full_name ILIKE '%' || ? || '%'", String(q.q));
  if (q.from && !isNaN(Date.parse(q.from))) add('r.created_at >= ?', new Date(q.from).toISOString());
  if (q.to && !isNaN(Date.parse(q.to))) add('r.created_at < ?', new Date(q.to).toISOString());
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const RESULT_COLUMNS = `r.id, g.slug, g.title AS game_title, r.full_name, r.grade, r.section, r.student_key,
  r.attempt_no, r.status, r.score, r.max_score, r.duration_s, r.details, r.created_at, r.finished_at`;

/* ---------- app ---------- */

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(cookieSession({
  name: 'gamehub', keys: [SESSION_SECRET], httpOnly: true, sameSite: 'lax',
  secure: IS_PROD, maxAge: 30 * 24 * 3600 * 1000,
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

function requireAdmin(req, res, next) {
  if (!req.session?.admin) return res.status(401).json({ error: 'Please log in.' });
  // Block changes sent from other sites or from inside a sandboxed game (Origin: null).
  const origin = req.get('origin');
  if (req.method !== 'GET' && origin && origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ error: 'Request blocked.' });
  }
  next();
}

app.get('/health', (req, res) => res.send('ok'));
app.use('/assets', express.static(path.join(PUBLIC, 'assets'), { maxAge: '1h' }));
app.get('/sdk.js', (req, res) => res.sendFile(path.join(PUBLIC, 'sdk.js'), { maxAge: '1h' }));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.get('/admin/results', (req, res) => res.sendFile(path.join(PUBLIC, 'results.html')));

/* ----- teacher login ----- */

const failedLogins = new Map(); // ip -> { count, until }
app.post('/api/login', (req, res) => {
  const now = Date.now(), ip = req.ip;
  const f = failedLogins.get(ip);
  if (f && f.until > now && f.count >= 10) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
  if (crypto.timingSafeEqual(sha(req.body?.password ?? ''), sha(ADMIN_PASSWORD))) {
    failedLogins.delete(ip);
    req.session.admin = true;
    return res.json({ ok: true });
  }
  const next = f && f.until > now ? { count: f.count + 1, until: f.until } : { count: 1, until: now + 15 * 60 * 1000 };
  failedLogins.set(ip, next);
  res.status(401).json({ error: 'Wrong password.' });
});
app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ admin: !!req.session?.admin }));

/* ----- games (teacher) ----- */

app.get('/api/games', requireAdmin, async (req, res) => {
  const { rows } = await query(`
    SELECT g.id, g.slug, g.title, g.active, g.created_at, g.updated_at, length(g.html)::int AS size,
           count(r.id)::int AS attempts, count(DISTINCT r.student_key)::int AS students
    FROM games g LEFT JOIN results r ON r.game_id = g.id
    GROUP BY g.id ORDER BY g.created_at DESC`);
  res.json(rows);
});

app.post('/api/games', requireAdmin, upload.single('file'), async (req, res) => {
  const slug = validateSlug(req.body.slug);
  const html = readUpload(req.file);
  if (!html) throw httpError(400, 'Please choose a game file.');
  const title = clean(req.body.title, 120) || titleFromHtml(html, slug);
  try {
    const { rows } = await query(
      'INSERT INTO games (slug, title, html) VALUES ($1, $2, $3) RETURNING id, slug, title', [slug, title, html]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw httpError(409, `The link name "${slug}" is already used by another game.`);
    throw e;
  }
});

app.put('/api/games/:id', requireAdmin, upload.single('file'), async (req, res) => {
  const html = readUpload(req.file);
  const title = req.body.title !== undefined ? clean(req.body.title, 120) : undefined;
  if (title === '') throw httpError(400, 'Title cannot be empty.');
  const active = req.body.active === undefined ? undefined : ['true', '1', 'on', true].includes(req.body.active);
  const { rows } = await query(
    `UPDATE games SET html = COALESCE($2, html), title = COALESCE($3, title), active = COALESCE($4, active), updated_at = now()
     WHERE id = $1 RETURNING id, slug, title, active`,
    [Number(req.params.id), html, title ?? null, active ?? null]);
  if (!rows.length) throw httpError(404, 'Game not found.');
  res.json(rows[0]);
});

app.delete('/api/games/:id', requireAdmin, async (req, res) => {
  const { rows } = await query('DELETE FROM games WHERE id = $1 RETURNING id', [Number(req.params.id)]);
  if (!rows.length) throw httpError(404, 'Game not found.');
  res.json({ ok: true });
});

/* ----- results (teacher) ----- */

app.get('/api/results', requireAdmin, async (req, res) => {
  const { where, params } = resultFilters(req.query);
  const { rows } = await query(
    `SELECT ${RESULT_COLUMNS} FROM results r JOIN games g ON g.id = r.game_id ${where}
     ORDER BY r.created_at DESC LIMIT 5000`, params);
  res.json(rows);
});

app.get('/api/results.csv', requireAdmin, async (req, res) => {
  const { where, params } = resultFilters(req.query);
  const { rows } = await query(
    `SELECT ${RESULT_COLUMNS} FROM results r JOIN games g ON g.id = r.game_id ${where}
     ORDER BY g.title, r.student_key, r.attempt_no`, params);
  // Stop Excel treating typed text as a formula.
  const cell = v => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['Game', 'Link', 'Full name', 'Grade', 'Section', 'Attempt', 'Status', 'Score', 'Max score', 'Time (seconds)', 'Started', 'Finished', 'Details'];
  const lines = rows.map(r => [r.game_title, r.slug, r.full_name, r.grade, r.section, r.attempt_no, r.status,
    r.score, r.max_score, r.duration_s, r.created_at, r.finished_at, r.details].map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="game-results-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + [head.join(','), ...lines].join('\r\n'));
});

// Two best students per game: each student's best attempt, ranked by score, then time, then who finished first.
app.get('/api/top', requireAdmin, async (req, res) => {
  const { rows } = await query(`
    WITH best AS (
      SELECT DISTINCT ON (game_id, student_key) *
      FROM results
      WHERE status <> 'started' AND score IS NOT NULL
      ORDER BY game_id, student_key, score DESC, duration_s ASC NULLS LAST, finished_at ASC
    ), ranked AS (
      SELECT best.*, ROW_NUMBER() OVER (PARTITION BY game_id
               ORDER BY score DESC, duration_s ASC NULLS LAST, finished_at ASC) AS place
      FROM best
    )
    SELECT ranked.id, ranked.game_id, g.slug, g.title AS game_title, ranked.full_name, ranked.grade, ranked.section,
           ranked.student_key, ranked.attempt_no, ranked.score, ranked.max_score, ranked.duration_s,
           ranked.finished_at, ranked.place::int AS place
    FROM ranked JOIN games g ON g.id = ranked.game_id
    WHERE ranked.place <= 2
    ORDER BY g.created_at DESC, ranked.place`);
  res.json(rows);
});

app.delete('/api/results/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM results WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

/* ----- attempts (students) ----- */

async function activeGame(slug) {
  const { rows } = await query('SELECT id, slug, title, html FROM games WHERE slug = $1 AND active', [String(slug).toLowerCase()]);
  return rows[0];
}

function readStudent(body) {
  const full_name = clean(body?.full_name, 80), grade = clean(body?.grade, 20), section = clean(body?.section, 20);
  if (!full_name || !grade || !section) throw httpError(400, 'Please enter your full name, grade and section.');
  return { full_name, grade, section, student_key: studentKey(full_name, grade, section) };
}

app.post('/api/attempts', async (req, res) => {
  const student = readStudent(req.body);
  const game = await activeGame(req.body?.slug ?? '');
  if (!game) throw httpError(404, 'This game is not available.');
  res.status(201).json(await createAttempt(game.id, student));
});

app.put('/api/attempts/:id', async (req, res) => {
  const { rows } = await query(
    'SELECT id, game_id, full_name, grade, section, student_key, status, token FROM results WHERE id = $1 AND token = $2',
    [Number(req.params.id), String(req.body?.token ?? '')]);
  let attempt = rows[0];
  if (!attempt) throw httpError(404, 'Attempt not found.');
  // The game reported a second result without reloading (its own "play again"): that is a new attempt.
  if (attempt.status !== 'started') attempt = { ...attempt, ...(await createAttempt(attempt.game_id, attempt)) };
  const r = parseResult(req.body?.result);
  await query(
    `UPDATE results SET status = $2, score = $3, max_score = $4, duration_s = $5, details = $6::jsonb, finished_at = now()
     WHERE id = $1`, [attempt.id, r.status, r.score, r.max_score, r.duration_s, r.details]);
  const { rows: [saved] } = await query('SELECT id, attempt_no, token FROM results WHERE id = $1', [attempt.id]);
  res.json(saved);
});

/* ----- game pages (students) ----- */

const playTemplate = fs.readFileSync(path.join(PUBLIC, 'play.html'), 'utf8');
const notFoundPage = fs.readFileSync(path.join(PUBLIC, '404.html'), 'utf8');

app.get('/play/:slug', async (req, res) => {
  const game = await activeGame(req.params.slug);
  if (!game) return res.status(404).type('html').send(notFoundPage);
  // Sandbox the game even if someone opens this address directly, so it can never reach the teacher's session.
  res.set('Content-Security-Policy', `sandbox ${SANDBOX}`);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(injectSdk(game.html));
});

app.get('/:slug', async (req, res) => {
  const game = await activeGame(req.params.slug);
  if (!game) return res.status(404).type('html').send(notFoundPage);
  const data = JSON.stringify({ slug: game.slug, title: game.title, sandbox: SANDBOX }).replace(/</g, '\\u003c');
  res.type('html').send(playTemplate
    .replaceAll('__TITLE__', escapeHtml(game.title))
    .replace('__GAME_JSON__', data));
});

app.use((req, res) => res.status(404).type('html').send(notFoundPage));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    err.status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') err.message = 'The file is too big (5 MB max).';
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
});

/* ---------- start ---------- */

await exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

// First run: add the games in ./games so the hub is not empty.
const { rows: [{ n }] } = await query('SELECT count(*)::int AS n FROM games');
if (n === 0) {
  for (const file of fs.readdirSync(path.join(ROOT, 'games')).filter(f => /\.html?$/i.test(f))) {
    const html = fs.readFileSync(path.join(ROOT, 'games', file), 'utf8');
    const slug = file.replace(/\.html?$/i, '').toLowerCase();
    await query('INSERT INTO games (slug, title, html) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING',
      [slug, titleFromHtml(html, slug), html]);
    console.log(`Added starter game /${slug}`);
  }
}

app.listen(PORT, () => console.log(`Game Hub running on http://localhost:${PORT} (database: ${dbKind})`));
