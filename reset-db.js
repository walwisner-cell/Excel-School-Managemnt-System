// One-off database reset script - run this from your own computer to wipe the
// remote database clean, since Render's free tier doesn't include Shell access.
//
// Usage:
//   node reset-db.js "YOUR_EXTERNAL_DATABASE_URL_HERE"
//
// Get YOUR_EXTERNAL_DATABASE_URL from: Render Dashboard -> school-management-db
// (the database service, not the web service) -> look for "External Database URL"
// or "External Connection String" and copy the whole thing (starts with postgresql://).

const { Client } = require('pg');

const connectionString = process.argv[2];
if (!connectionString) {
  console.error('Usage: node reset-db.js "YOUR_EXTERNAL_DATABASE_URL"');
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

client.connect()
  .then(() => {
    console.log('Connected. Dropping and recreating the public schema...');
    return client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  })
  .then(() => {
    console.log('Done. The database is now empty - trigger a Manual Deploy on Render to rebuild it.');
    return client.end();
  })
  .catch((err) => {
    console.error('Something went wrong:', err.message);
    process.exit(1);
  });
