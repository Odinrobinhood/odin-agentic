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
const signer = new Signer({
  config,
  seed,
  policies: new PgPolicyStore(pool),
  ledger: new PgLedger(pool),
  chain: new ViemChainReader(config.rpcUrls),
});

await signer.preflight();
await listen(createChannelServer(signer, 'agent', config.agentToken), config.agentListen);
await listen(createChannelServer(signer, 'guard', config.guardToken), config.guardListen);
console.log(JSON.stringify({ msg: 'signer up', chainId: config.chainId, agent: config.agentListen, guard: config.guardListen }));
