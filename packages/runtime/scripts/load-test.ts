/**
 * Load test of the scheduler + Agent Runtime (architecture §10). Runs the PRODUCTION scheduler (PgSchedule
 * leases) and runTick code against a scratch database; only the LLM is replaced by a scripted provider with
 * realistic latency. Market data, the Risk Engine (real QuoterV2 / Chainlink reads), paper fills, positions and
 * TP/SL arming are all real. Paper mode only: nothing is signed or broadcast.
 *
 *   DATABASE_URL=<scratch db with tokens/routes/snapshots copied> node packages/runtime/scripts/load-test.ts
 *
 * env: LOAD_AGENTS (300), LOAD_SECONDS (600), LOAD_WORKERS (1: simulated runtime replicas),
 *      LOAD_CONCURRENCY (8 per worker, same as RUNTIME_CONCURRENCY), LOAD_LLM_MS (6000 mean model latency),
 *      LOAD_TRADE_PCT (25: share of decisions that buy or sell), LOAD_ASSETS (comma-separated token addresses)
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { cpus, loadavg } from 'node:os';
import type { DecisionProvider } from '@odin/decision';
import { buildRuntime, runTick } from '../src/index.ts';
import { PgSchedule } from '../src/scheduler.ts';

const N = Number(process.env.LOAD_AGENTS ?? 300);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 600);
const WORKERS = Number(process.env.LOAD_WORKERS ?? 1);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 8);
const LLM_MS = Number(process.env.LOAD_LLM_MS ?? 6000);
const TRADE_PCT = Number(process.env.LOAD_TRADE_PCT ?? 25);
const ASSETS = (process.env.LOAD_ASSETS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
if (!ASSETS.length) throw new Error('LOAD_ASSETS is required');

// model latency: log-normal around LLM_MS (thinking models have a long tail)
const latency = () => Math.min(LLM_MS * 5, Math.exp(Math.log(LLM_MS) - 0.18 + 0.6 * Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random())));
/** model time spent inside the current tick, so the platform's own time can be reported separately */
const llmTime = new AsyncLocalStorage<{ ms: number }>();
const thesis = { claim: 'load test', horizon_ticks: 3, invalidated_if: 'n/a' };
const scripted: DecisionProvider = {
  name: 'scripted-load',
  supports: () => true,
  complete: async (req) => {
    const wait = latency();
    await new Promise((r) => setTimeout(r, wait));
    const acc = llmTime.getStore();
    if (acc) acc.ms += wait;
    const roll = Math.random() * 100;
    const token = ASSETS[Math.floor(Math.random() * ASSETS.length)]!;
    const d =
      roll < TRADE_PCT * 0.6
        ? { action: 'buy', token, size: { type: 'quote_amount', value: '10' }, rationale: 'load buy', thesis, confidence: 0.5 }
        : roll < TRADE_PCT
          ? { action: 'sell', token, size: { type: 'fraction_of_position', value: '0.5' }, rationale: 'load sell', thesis, confidence: 0.5 }
          : { action: 'hold', token: null, size: null, rationale: 'load hold', thesis, confidence: 0.5 };
    return { text: JSON.stringify(d), stopReason: 'end_turn', model: req.model, tokensUsed: 3000 };
  },
};

const { pool, store, deps, usdg } = buildRuntime(process.env, { providers: [scripted] });

// ── setup: N paper agents, one user each, cadence 60 s (the floor) ──────────────────────────────────────
console.error(`setup: ${N} agents`);
await pool.query("UPDATE agents SET status = 'retired' WHERE name LIKE 'load-%'");
await pool.query('DELETE FROM agent_schedule');
const base = 10_000_000 + Math.floor(Math.random() * 1_000_000) * 1000;
for (let i = 0; i < N; i++) {
  const addr = `0x${randomUUID().replaceAll('-', '')}${'0'.repeat(8)}`.slice(0, 42);
  const u = await pool.query<{ id: string }>('INSERT INTO users (wallet_address) VALUES ($1) RETURNING id', [addr]);
  const a = await pool.query<{ id: string }>(
    "INSERT INTO agents (user_id, name, status, mode) VALUES ($1, $2, 'active', 'paper') RETURNING id",
    [u.rows[0]!.id, `load-${i}`],
  );
  const id = a.rows[0]!.id;
  await pool.query(
    `INSERT INTO agent_configs (agent_id, version, system_prompt, model_provider, model_name, temperature, max_tokens, quote_asset, cadence_seconds)
     VALUES ($1, 1, 'load test mandate', 'anthropic', 'claude-sonnet-5-5', 0, 2000, $2, 60)`,
    [id, usdg.toLowerCase()],
  );
  // imported custody: the signer never binds or signs for these (paper only)
  await pool.query("INSERT INTO agent_wallets (agent_id, address, derivation_index, custody) VALUES ($1, $2, $3, 'imported')", [id, `0x${randomUUID().replaceAll('-', '')}${'1'.repeat(8)}`.slice(0, 42), base + i]);
  for (const t of ASSETS) await pool.query('INSERT INTO agent_assets (agent_id, token_address) VALUES ($1, $2)', [id, t]);
  await pool.query(`INSERT INTO tp_sl_defaults (agent_id, sl_enabled, sl_mode, sl_value, tp_enabled, tp_mode, tp_value) VALUES ($1, true, 'pct', 5, true, 'pct', 10)`, [id]);
  await store.setPaperBalance(id, usdg, 1_000_000_000n);
}
// spread first ticks over one cadence like a real fleet (not all due at once)
await new PgSchedule(pool).enroll();
await pool.query("UPDATE agent_schedule SET next_tick_at = now() + make_interval(secs => random() * 60)");

// ── run W scheduler loops (the production loop from src/main.ts) ─────────────────────────────────────
const ticks: { ms: number; llmMs: number; lagMs: number; outcome: string; code?: string; error?: string }[] = [];
const lagSamples: { t: number; overdue: number; maxLagS: number }[] = [];
const started = Date.now();
const until = started + SECONDS * 1000;
let cpuPrev = process.cpuUsage();

async function worker(w: number) {
  const schedule = new PgSchedule(pool);
  const owner = `load:${w}:${randomUUID().slice(0, 8)}`;
  const running = new Set<Promise<void>>();
  while (Date.now() < until) {
    const free = CONCURRENCY - running.size;
    const due = free > 0 ? await schedule.claimDue(owner, free, 5 * 60_000) : [];
    for (const agentId of due) {
      const p = (async () => {
        const t0 = Date.now();
        const lag = await pool.query<{ lag: number }>('SELECT extract(epoch FROM now() - next_tick_at) * 1000 AS lag FROM agent_schedule WHERE agent_id = $1', [agentId]);
        let error: string | undefined;
        const acc = { ms: 0 };
        try {
          const r = await llmTime.run(acc, () => runTick(deps, agentId));
          ticks.push({ ms: Date.now() - t0, llmMs: acc.ms, lagMs: Number(lag.rows[0]?.lag ?? 0), outcome: r.outcome, ...('code' in r && r.code ? { code: r.code } : {}) });
        } catch (e) {
          error = (e as Error).message.split('\n')[0]!.slice(0, 160);
          ticks.push({ ms: Date.now() - t0, llmMs: acc.ms, lagMs: Number(lag.rows[0]?.lag ?? 0), outcome: 'error', error });
        } finally {
          await schedule.complete(agentId, owner, { error }).catch(() => {});
        }
      })();
      running.add(p);
      void p.finally(() => running.delete(p));
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  await Promise.all(running);
}

const sampler = setInterval(async () => {
  const r = await pool
    .query<{ overdue: number; max_lag: number }>(
      `SELECT count(*)::int AS overdue, coalesce(extract(epoch FROM max(now() - next_tick_at)), 0)::float AS max_lag
         FROM agent_schedule s JOIN agents a ON a.id = s.agent_id WHERE a.status = 'active' AND s.next_tick_at <= now() AND s.lease_until IS NULL`,
    )
    .catch(() => null);
  if (r) lagSamples.push({ t: Math.round((Date.now() - started) / 1000), overdue: r.rows[0]!.overdue, maxLagS: Math.round(r.rows[0]!.max_lag) });
  const done = ticks.length;
  if (lagSamples.length % 6 === 0) console.error(`t=${lagSamples.at(-1)?.t}s ticks=${done} overdue=${lagSamples.at(-1)?.overdue} maxLag=${lagSamples.at(-1)?.maxLagS}s pool=${pool.totalCount}/${pool.idleCount}idle/${pool.waitingCount}waiting`);
}, 5_000);

await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
clearInterval(sampler);
const cpu = process.cpuUsage(cpuPrev);
cpuPrev = cpu;

// ── report ─────────────────────────────────────────────────────────────────────────────────────────
const pct = (xs: number[], p: number) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : 0);
const elapsedS = (Date.now() - started) / 1000;
const steady = lagSamples.filter((s) => s.t >= 120);
const by = (k: (t: (typeof ticks)[number]) => string | undefined) =>
  Object.fromEntries(Object.entries(ticks.reduce<Record<string, number>>((m, t) => ((m[k(t) ?? '-'] = (m[k(t) ?? '-'] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]));
const report = {
  scenario: { agents: N, seconds: SECONDS, workers: WORKERS, concurrencyPerWorker: CONCURRENCY, llmMeanMs: LLM_MS, tradePct: TRADE_PCT, assets: ASSETS.length },
  required: { ticksPerMin: N, capacityEstimatePerMin: Math.round((WORKERS * CONCURRENCY * 60_000) / (LLM_MS + 400)) },
  achieved: { ticks: ticks.length, ticksPerMin: Math.round((ticks.length / elapsedS) * 60) },
  tickMs: { p50: pct(ticks.map((t) => t.ms), 50), p95: pct(ticks.map((t) => t.ms), 95), p99: pct(ticks.map((t) => t.ms), 99), max: pct(ticks.map((t) => t.ms), 100) },
  platformMs: { p50: Math.round(pct(ticks.map((t) => t.ms - t.llmMs), 50)), p95: Math.round(pct(ticks.map((t) => t.ms - t.llmMs), 95)), max: Math.round(pct(ticks.map((t) => t.ms - t.llmMs), 100)) },
  byOutcomePlatformMsP50: Object.fromEntries([...new Set(ticks.map((t) => t.outcome))].map((o) => [o, Math.round(pct(ticks.filter((t) => t.outcome === o).map((t) => t.ms - t.llmMs), 50))])),
  startLagS: { p50: Math.round(pct(ticks.map((t) => t.lagMs), 50) / 1000), p95: Math.round(pct(ticks.map((t) => t.lagMs), 95) / 1000), max: Math.round(pct(ticks.map((t) => t.lagMs), 100) / 1000) },
  backlogAfter2min: { overdueMax: Math.max(0, ...steady.map((s) => s.overdue)), maxLagS: Math.max(0, ...steady.map((s) => s.maxLagS)), lastLagS: lagSamples.at(-1)?.maxLagS ?? null },
  outcomes: by((t) => t.outcome),
  codes: by((t) => t.code ?? t.error),
  process: { cpuSec: Math.round((cpu.user + cpu.system) / 1e6), cpuCores: cpus().length, load1: loadavg()[0]?.toFixed(2), rssMb: Math.round(process.memoryUsage().rss / 1e6), dbPoolMax: pool.totalCount },
};
console.log(JSON.stringify(report, null, 2));
await pool.query("UPDATE agents SET status = 'retired' WHERE name LIKE 'load-%'");
await pool.end();
process.exit(0);
