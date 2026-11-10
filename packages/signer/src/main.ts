import { createPool } from '@odin/db';
import { loadConfig } from './config.ts';
import { readSeed } from './keys.ts';
import { PgPolicyStore } from './policy.ts';
import { PgLedger } from './ledger.ts';
import { ViemChainReader } from './chain.ts';
import { Signer } from './signer.ts';
import { createChannelServer, listen } from './server.ts';

const config = loadConfig();
const seed = readSeed(config.seedFile);
const pool = createPool(config.databaseUrl, { max: 5 });
const policies = new PgPolicyStore(pool, (i) => signer.addressFor(i));
const signer: Signer = new Signer({
  config,
  seed,
  policies,
  ledger: new PgLedger(pool),
  chain: new ViemChainReader(config.rpcUrls),
});

await signer.preflight();
await listen(createChannelServer(signer, 'agent', config.agentToken), config.agentListen);
await listen(createChannelServer(signer, 'guard', config.guardToken), config.guardListen);
// vault bindings: written as soon as an agent wallet exists, before funds or signature requests arrive
const bind = async () => {
  try {
    const n = await policies.bindAll();
    if (n) console.log(JSON.stringify({ msg: 'wallets bound', n }));
  } catch (e) {
    console.error(JSON.stringify({ msg: 'bindAll failed', error: (e as Error).message }));
  }
};
await bind();
setInterval(bind, 5_000).unref();
console.log(JSON.stringify({ msg: 'signer up', chainId: config.chainId, agent: config.agentListen, guard: config.guardListen }));
