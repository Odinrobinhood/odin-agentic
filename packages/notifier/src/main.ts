import { createPool } from '@odin/db';
import { Notifier, PgNotifyStore, TelegramSender, type Sender } from './notifier.ts';

const pool = createPool(process.env.DATABASE_URL ?? 'postgresql://odin@/odin?host=/var/run/postgresql', { max: 3 });
const senders: Sender[] = [];
if (process.env.TELEGRAM_BOT_TOKEN) senders.push(new TelegramSender(process.env.TELEGRAM_BOT_TOKEN));
const notifier = new Notifier(new PgNotifyStore(pool), senders);
const log = (o: object) => console.log(JSON.stringify(o));
log({ msg: 'notifier up', channels: ['in_app', ...senders.map((s) => s.kind)] });

for (;;) {
  try {
    const r = await notifier.deliverOnce();
    if (r.delivered || r.failed) log({ msg: 'notify', ...r });
  } catch (e) {
    log({ msg: 'notify pass failed', error: (e as Error).message });
  }
  await new Promise((r) => setTimeout(r, 2_000));
}
