import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/duraflows-pg/package.json", import.meta.url));
const { Pool } = require("pg");
const prefix = process.env.STRYKER_POSTGRES_DATABASE_PREFIX;
if (!process.env.DATABASE_URL || !/^duraflows_stryker_[a-f0-9]{12}_$/.test(prefix ?? "")) {
  throw new Error("Start PostgreSQL mutation testing with pnpm test:mutation:postgres.");
}

const database = `${prefix}${process.pid}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  // Each test runner, including a replacement after a timeout, owns a fresh DB.
  await admin.query(`CREATE DATABASE "${database}"`);
} finally {
  await admin.end();
}
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/${database}`;
process.env.DATABASE_URL = url.toString();
