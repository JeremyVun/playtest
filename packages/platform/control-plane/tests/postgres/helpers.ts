import { randomBytes } from "node:crypto";
import pg from "pg";
import { connect } from "../../src/db.ts";
import { after } from "node:test";

const cleanup: Array<() => Promise<void>> = [];
after(async () => { for (const close of cleanup.reverse()) await close(); });

export async function testDatabase() {
  const raw = process.env.PLAYTEST_TEST_POSTGRES_URL;
  if (!raw) throw new Error("Set PLAYTEST_TEST_POSTGRES_URL to the disposable local Postgres test service");
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/playtest_test_admin") {
    throw new Error("Postgres tests require a loopback playtest_test_admin database; production databases are refused");
  }
  const admin = new pg.Client({ connectionString: raw, connectionTimeoutMillis: 5000 });
  await admin.connect();
  const name = `pt_test_${randomBytes(12).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  try {
    await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE ${name} OWNER ${name} TEMPLATE template0`);
  } catch (error) {
    await admin.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
    throw error;
  }
  url.pathname = `/${name}`;
  url.username = name;
  url.password = password;
  let closed = false;
  const fixture = {
    databaseUrl: url.href,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        await admin.query(`DROP ROLE ${name}`);
      } finally { await admin.end(); }
    },
  };
  cleanup.push(() => fixture.close());
  return fixture;
}

export async function connectTestDb() {
  const fixture = await testDatabase();
  try {
    const db = await connect(fixture);
    const end = db.end.bind(db);
    db.end = async () => { try { await end(); } finally { await fixture.close(); } };
    cleanup.push(() => db.end());
    return db;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
