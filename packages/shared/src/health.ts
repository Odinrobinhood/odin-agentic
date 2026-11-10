import { createServer, type Server } from 'node:http';

/**
 * Per-service health endpoint (architecture §8): GET /healthz on a loopback port reports the build commit
 * and whether the service's main loop has beaten recently. A loop that hangs turns the service unhealthy
 * even though the process is still alive.
 */
export class Health {
  private lastBeat = Date.now();
  private lastError: string | null = null;
  private readonly service: string;
  private readonly maxSilenceMs: number;
  private server: Server | null = null;

  constructor(service: string, maxSilenceMs: number) {
    this.service = service;
    this.maxSilenceMs = maxSilenceMs;
  }

  /** Call once per completed loop iteration. */
  beat(): void {
    this.lastBeat = Date.now();
    this.lastError = null;
  }

  fail(error: string): void {
    this.lastError = error.slice(0, 300);
  }

  status() {
    const silentMs = Date.now() - this.lastBeat;
    return { ok: silentMs <= this.maxSilenceMs, service: this.service, commit: process.env.BUILD_COMMIT ?? 'dev', silentMs, lastError: this.lastError };
  }

  /** Listen on 127.0.0.1:<port> (HEALTH_PORT overrides). Never exposes anything but the status. */
  listen(defaultPort: number): this {
    const port = Number(process.env.HEALTH_PORT ?? defaultPort);
    this.server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/healthz') {
        res.writeHead(404).end();
        return;
      }
      const s = this.status();
      res.writeHead(s.ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(s));
    });
    this.server.listen(port, '127.0.0.1');
    this.server.unref();
    return this;
  }
}

/** Loopback health ports per service (signer 7401/7402 and API 7500 have their own /healthz). */
export const HEALTH_PORTS = {
  market: 7601,
  runtime: 7602,
  guard: 7603,
  notifier: 7604,
  indexer: 7605,
  signals: 7606,
  watchdog: 7607,
  backtest: 7608,
} as const;

/** Health endpoints by service name (shared by the watchdog and the public status page). */
export const HEALTH_URLS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(HEALTH_PORTS).map(([k, p]) => [k, `http://127.0.0.1:${p}/healthz`])),
  signer: 'http://127.0.0.1:7401/healthz',
  api: 'http://127.0.0.1:7500/healthz',
  web: 'http://127.0.0.1:3000/',
};
