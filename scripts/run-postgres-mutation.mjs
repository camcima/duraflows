import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  throw new Error("The PostgreSQL mutation pass requires DATABASE_URL pointing to a disposable test database.");
}
const require = createRequire(new URL("../packages/duraflows-pg/package.json", import.meta.url));
const { Pool } = require("pg");
const prefix = `duraflows_stryker_${randomBytes(6).toString("hex")}_`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });

async function run(args, env = process.env) {
  const child = spawn(process.execPath, args, { stdio: "inherit", env });
  const onInterrupt = () => child.kill("SIGINT");
  const onTerminate = () => child.kill("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

try {
  const { rows } = await admin.query(
    "SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname = current_user",
  );
  if (!rows[0]?.allowed)
    throw new Error("PostgreSQL mutation testing requires a role allowed to create worker databases.");
  const stryker = fileURLToPath(new URL("../node_modules/@stryker-mutator/core/bin/stryker.js", import.meta.url));
  process.exitCode = await run([stryker, "run", "stryker.postgres.config.mjs", ...process.argv.slice(2)], {
    ...process.env,
    STRYKER_POSTGRES_DATABASE_PREFIX: prefix,
  });
  if (process.exitCode === 0 && !process.argv.includes("--dryRunOnly")) {
    process.exitCode = await run([
      fileURLToPath(new URL("./check-mutation-report.mjs", import.meta.url)),
      "reports/mutation/postgres/mutation.json",
    ]);
  }
} finally {
  try {
    const { rows } = await admin.query("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [prefix]);
    for (const { datname } of rows) {
      if (!/^[a-z0-9_]+$/.test(datname) || !datname.startsWith(prefix))
        throw new Error("Unexpected worker database name");
      await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
    }
    console.log(`Cleaned up ${rows.length} isolated mutation worker databases.`);
  } finally {
    await admin.end();
  }
}
