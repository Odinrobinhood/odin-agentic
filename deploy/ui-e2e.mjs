// Browser click-through of the web app as a real user (staging). Run by deploy/ui-e2e.sh.
//
// A throwaway wallet is generated for this run (random key, no funds, never stored) and injected as
// window.ethereum, so SIWE login, step-up and every page work exactly as with a browser wallet. The agent it
// creates trades in PAPER mode only and is retired at the end. Screenshots go to $OUT.
import { chromium } from 'playwright';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// SIWE signs for the public domain, so the click-through goes through Caddy + TLS like a real visitor.
const BASE = process.env.BASE_URL ?? 'https://odinrobinhood.com';
const OUT = process.env.OUT ?? '/tmp/odin-ui';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const account = privateKeyToAccount(generatePrivateKey());

const steps = [];
const problems = [];
const t0 = Date.now();
const step = async (name, fn) => {
  const s = Date.now();
  try {
    await fn();
    steps.push({ name, ok: true, ms: Date.now() - s });
  } catch (e) {
    steps.push({ name, ok: false, ms: Date.now() - s, error: String(e.message ?? e).split('\n')[0].slice(0, 300) });
  }
};

const browser = await chromium.launch();
async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.exposeFunction('__odinWallet', async (method, params) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'personal_sign') return account.signMessage({ message: /^0x[0-9a-f]*$/i.test(params[0]) ? { raw: params[0] } : params[0] });
    if (method === 'wallet_switchEthereumChain') return null;
    throw new Error(`unsupported wallet method ${method}`);
  });
  // Two wallet extensions announce themselves over EIP-6963, like a real browser with MetaMask + another wallet:
  // "Test Wallet" signs with the throwaway key, "Grumpy Wallet" declines every request (EIP-1193 code 4001).
  await page.addInitScript(() => {
    const good = { isMetaMask: true, request: ({ method, params }) => window.__odinWallet(method, params ?? []), on() {}, removeListener() {} };
    const bad = { request: async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }, on() {}, removeListener() {} };
    window.ethereum = good;
    const announce = () => {
      for (const [provider, name, rdns] of [[bad, 'Grumpy Wallet', 'test.grumpy'], [good, 'Test Wallet', 'test.good']]) {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: rdns, name, rdns, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' }, provider }) }));
      }
    };
    window.addEventListener('eip6963:requestProvider', announce);
  });
  page.on('console', (m) => m.type() === 'error' && problems.push({ kind: 'console', page: page.url(), text: m.text().slice(0, 300) }));
  page.on('pageerror', (e) => problems.push({ kind: 'pageerror', page: page.url(), text: String(e.message).slice(0, 300) }));
  page.on('response', (r) => r.status() >= 500 && problems.push({ kind: 'http', page: page.url(), text: `${r.status()} ${r.url()}` }));
  page.on('dialog', (d) => d.accept());
  return page;
}
const shot = (page, name, full = true) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
const api = (page, method, path, body) =>
  page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(`/api/v1${p}`, { method: m, headers: { 'x-odin': '1', ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, path, body],
  );

const page = await newPage({ width: 1440, height: 900 });
let agentId = null;

await step('landing renders', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByText('not hope.').waitFor();
  await page.waitForTimeout(2500);
  const film = await page.evaluate(() => { const v = document.querySelector('video.film'); return v ? { t: v.currentTime, ready: v.readyState, paused: v.paused } : null; });
  if (!film || film.paused || film.t <= 0) throw new Error(`hero film not playing: ${JSON.stringify(film)}`);
  await shot(page, '01-landing');
});
await step('connect: declined wallet shows a clear error, another wallet signs in (SIWE)', async () => {
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('dialog').getByText('Choose a wallet').waitFor({ timeout: 10_000 });
  await shot(page, '02a-connect-pick', false);
  await page.getByRole('button', { name: 'Grumpy Wallet' }).click();
  await page.getByRole('dialog').getByText('declined in Grumpy Wallet').waitFor({ timeout: 10_000 });
  await shot(page, '02b-connect-declined', false);
  await page.getByRole('button', { name: 'Use another wallet' }).click();
  await page.getByRole('button', { name: 'Test Wallet' }).click();
  await page.waitForURL('**/agents', { timeout: 30_000 });
  await page.waitForTimeout(800);
  await shot(page, '02-agents-empty');
});
await step('create agent', async () => {
  await page.fill('#new-agent', 'UI Test Agent');
  await page.getByRole('button', { name: 'Create agent' }).click();
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  agentId = page.url().split('/').pop();
  await page.waitForTimeout(800);
  await shot(page, '03-agent-new');
});
const tab = (name) => page.locator('.tabs button', { hasText: name }).click();
await step('strategy: write and save', async () => {
  await tab('Strategy');
  await page.locator('textarea').first().fill('Trend follower: buy a token with 50 USDG when its last two hourly candles both closed up and you hold none; sell the whole position when the last hourly candle closed more than 1.5% down. Otherwise hold.');
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await page.getByText('Saved').first().waitFor({ timeout: 20_000 });
  await shot(page, '04-strategy');
});
await step('assets: add WETH and NVDA by address', async () => {
  await tab('Assets');
  for (const a of [WETH, NVDA]) {
    await page.locator('input[placeholder="0x…"]').last().fill(a);
    await page.locator('input[placeholder="0x…"]').last().locator('xpath=following-sibling::button').click();
    await page.waitForTimeout(2500);
  }
  await page.locator('table').last().getByText('NVDA').first().waitFor({ timeout: 30_000 });
  await page.locator('input[placeholder^="e.g. TSLA"]').fill('nvda');
  await page.waitForTimeout(1500);
  await shot(page, '05-assets');
});
await step('protection: TP/SL defaults', async () => {
  await tab('Risk');
  await page.locator('label:has-text("Stop loss") + div input').fill('5');
  await page.locator('label:has-text("Take profit") + div input').fill('8');
  await page.getByRole('button', { name: 'Save TP/SL' }).click();
  await page.waitForTimeout(1500);
  await shot(page, '06-protection');
});
await step('funds: set paper cash', async () => {
  await tab('Funds');
  await page.getByRole('button', { name: 'Set paper cash' }).click();
  await page.getByText('Paper balance set').waitFor({ timeout: 20_000 });
  await shot(page, '07-funds');
});
await step('activate and get a real AI decision (paper)', async () => {
  await tab('Overview');
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.waitForTimeout(1500);
  let decisions = [];
  for (let i = 0; i < 40 && decisions.length === 0; i++) {
    await page.waitForTimeout(5000);
    decisions = (await api(page, 'GET', `/agents/${agentId}/decisions?limit=5`)).body ?? [];
  }
  if (decisions.length === 0) throw new Error('no decision within 200 s');
  await page.reload({ waitUntil: 'networkidle' });
  await shot(page, '08-overview-active');
  await tab('Activity');
  await page.waitForTimeout(1500);
  await shot(page, '09-activity');
});
await step('backtest tab renders', async () => {
  await tab('Backtest');
  await page.waitForTimeout(1200);
  await shot(page, '10-backtest');
});
await step('analyst answers with on-chain data', async () => {
  await page.goto(`${BASE}/analyst`, { waitUntil: 'networkidle' });
  await page.locator('input[placeholder^="e.g. Who has"]').fill('What is the current USDG price of NVDA on Robinhood Chain?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await page.locator('.bubble.assistant:not(.muted)').first().waitFor({ timeout: 180_000 });
  await shot(page, '11-analyst');
});
for (const [path, name] of [['/alerts', '12-signals'], ['/portfolio', '13-portfolio'], ['/notifications', '14-notifications'], ['/docs', '15-docs'], ['/status', '16-status'], ['/agents', '17-agents-list']]) {
  await step(`page ${path}`, async () => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await shot(page, name);
  });
}

const phone = await newPage({ width: 390, height: 844 });
await step('mobile: landing and agents', async () => {
  await phone.goto(BASE, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(1000);
  await shot(phone, '20-mobile-landing', false);
  await phone.goto(`${BASE}/docs`, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(800);
  await shot(phone, '21-mobile-docs', false);
});

await step('cleanup: retire the test agent', async () => {
  if (agentId) await api(page, 'POST', `/agents/${agentId}/status`, { action: 'retire' });
});
await browser.close();
const report = { wallet: `${account.address.slice(0, 6)}…`, agentId, seconds: Math.round((Date.now() - t0) / 1000), passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length, steps, problems: problems.slice(0, 40) };
console.log(JSON.stringify(report, null, 2));
