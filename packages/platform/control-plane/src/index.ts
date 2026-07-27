#!/usr/bin/env node
// Control-plane entrypoint. `playtest-server` starts the HTTP service;
// `playtest-server migrate` applies pending migrations and exits (the deploy hook).
// Config errors surface friendly and exit 2 (the DummyConfigError discipline); they
// name the offending variable, never a stack trace.
import { loadConfig, ServerConfigError } from "./config.ts";
import { connect } from "./db.ts";
import { migrate } from "./migrate.ts";
import { createApp } from "./app.ts";
import { runRetentionCycle } from "./retention/worker.ts";

async function main() {
  const cmd = process.argv[2];
  const config = loadConfig(process.env);

  if (cmd === "migrate") {
    const db = await connect(config);
    const ran = await migrate(db, { log: (m) => console.log(m) });
    console.log(ran.length ? `applied ${ran.length} migration(s)` : "database is up to date");
    await db.end();
    return;
  }

  if (cmd === "retention-once") {
    const app = await createApp(config);
    try {
      console.log(JSON.stringify(await runRetentionCycle(app.ctx), null, 2));
    } finally {
      await app.close();
    }
    return;
  }

  const app = await createApp(config);
  await app.listen();
  app.log.info({
    msg: `Playtest control plane listening on http://${config.host}:${config.port} ` +
      `(auth: ${config.auth.mode}, store: ${config.objectStore.kind})`,
  });
}

main().catch((e) => {
  if (e instanceof ServerConfigError) {
    console.error(`\nConfiguration error:\n  ${e.message}\n`);
    process.exit(2);
  }
  console.error(e?.stack || String(e));
  process.exit(1);
});
