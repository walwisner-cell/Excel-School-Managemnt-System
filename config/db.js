// Shared PostgreSQL connection pool.
// Both the Express app (via src/routes/*) and the CLI scripts (scripts/migrate.js,
// scripts/seed.js) import this same module, so there is exactly one pool per process.
require('dotenv').config();
const { Pool } = require('pg');

// Two supported connection styles, so this works with whichever a given host
// gives you without editing code:
//   1. A single DATABASE_URL (Railway, Heroku-style platforms)
//   2. Individual PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD (Render's `fromDatabase`,
//      a local Postgres, or a traditional VPS)
// SSL is enabled automatically whenever DATABASE_URL is used, since that's the
// style hosted providers reach over the public internet with; set
// PGSSLMODE=disable to turn it off (e.g. connecting to a local DB via DATABASE_URL).
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    }
  : {
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
    };

const pool = new Pool({
  ...poolConfig,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // A backend-idle client emitted an error (e.g. connection dropped by the server).
  // Don't crash the process - just log it. Query-time errors are handled by callers.
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

module.exports = pool;
