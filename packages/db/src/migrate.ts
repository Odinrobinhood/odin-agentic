import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool } from './index.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const pool = createPool(url, { max: 1 });
const client = await pool.connect();
try {
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
  const done = new Set(applied.rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`applied ${f}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  console.log('migrations up to date');
} finally {
  client.release();
  await pool.end();
}
