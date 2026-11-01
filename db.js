// Database access. Uses PostgreSQL (e.g. Neon) when DATABASE_URL is set,
// otherwise an embedded Postgres (PGlite) stored in ./data for local development.
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.DATABASE_URL;
let impl;

if (url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  impl = {
    kind: 'postgres',
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
  };
} else {
  if (process.env.RENDER) {
    // Render's disk is wiped on every deploy/restart, so a local database would lose all data.
    console.error('DATABASE_URL is not set. Add your Neon connection string in the Render dashboard.');
    process.exit(1);
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = path.resolve(process.env.PGLITE_DIR || 'data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  impl = {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
  };
  console.log(`Using local embedded database in ${dir}`);
}

export const query = impl.query;
export const exec = impl.exec;
export const dbKind = impl.kind;
