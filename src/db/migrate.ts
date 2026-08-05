import fs from "fs";
import path from "path";
import { ccDb } from "../config/db";

/**
 * Minimal migration runner: executes every .sql file in db/migrations/, in
 * filename order, inside a single transaction per file. Tracks what's been
 * run in a `cc_schema_migrations` table so re-running is a no-op.
 *
 * Usage: npm run migrate
 */
async function main() {
  await ccDb.query(`
    CREATE TABLE IF NOT EXISTS cc_schema_migrations (
      filename TEXT PRIMARY KEY,
      run_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const { rows } = await ccDb.query(
      "SELECT 1 FROM cc_schema_migrations WHERE filename = $1",
      [file]
    );
    if (rows.length > 0) {
      console.log(`[migrate] skip (already applied): ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    console.log(`[migrate] applying: ${file}`);
    const client = await ccDb.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO cc_schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`[migrate] done: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[migrate] FAILED: ${file}`, err);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log("[migrate] all migrations applied");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
