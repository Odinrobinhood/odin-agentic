import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, opts: { max?: number } = {}): pg.Pool {
  return new pg.Pool({ connectionString, max: opts.max ?? 10 });
}
