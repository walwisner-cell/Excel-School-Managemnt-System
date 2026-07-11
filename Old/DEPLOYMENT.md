# Deployment Guide

This is one Node/Express app that serves both the API (`/api/*`) and the
frontend (`public/index.html`) on a single port — one service to deploy, not
a separate frontend + backend.

Two things make this simpler than a typical Node+Postgres deploy:

1. **`npm start` provisions itself.** It runs `scripts/migrate.js` and
   `scripts/seed.js` before starting the server. Both are fully idempotent
   (safe to run on every boot/redeploy - they check what already exists
   before creating anything), so there's no separate "run migrations" step
   to remember on any platform.
2. **The database connection auto-adapts.** `config/db.js` accepts either a
   single `DATABASE_URL` or the individual `PGHOST`/`PGPORT`/`PGDATABASE`/
   `PGUSER`/`PGPASSWORD` variables - whichever style your host gives you
   works without touching code.

## Path A — Render, one-click Blueprint (simplest)

This repo includes `render.yaml`, which defines the web service **and** its
Postgres database together, with a database connection wired automatically
and a fresh `JWT_SECRET` generated for you.

1. Push this project to a GitHub repo (with `render.yaml` at the root).
2. Go to the [Render Dashboard](https://dashboard.render.com) → **New →
   Blueprint** → connect your repo.
3. Render reads `render.yaml` and shows you what it's about to create. It'll
   prompt you for two values it can't generate itself:
   - `BOOTSTRAP_ADMIN_EMAIL` - the email for your first super_admin login
   - `BOOTSTRAP_ADMIN_PASSWORD` - a strong password (there's no in-app
     "change password" UI yet, so pick one you're happy to keep, or update it
     directly in the database afterward)
4. Click **Deploy Blueprint**. Render provisions the database, builds the
   app, and runs `npm start` - which migrates the schema, seeds roles/
   permissions/the demo school, and starts serving, all in one boot.
5. Once it's live, open the `.onrender.com` URL Render gives you. Log in with
   the bootstrap admin (school code blank), create a `school_admin` for
   school code `DEMO01` from Users & Access, and confirm you can create a
   class/student.

**One limitation on the free tier**: Render's free web services have an
ephemeral filesystem, so uploaded documents/photos (stored under `uploads/`)
won't survive a redeploy. `render.yaml` has a commented-out `disk:` block
with instructions - uncomment it and upgrade the web service's `plan` to a
paid tier (e.g. `starter`) once you're ready for uploads to persist.

Every `git push` after this auto-redeploys (Render watches your connected
branch). If you change `schema.sql`, nothing extra to do - the next boot
picks it up automatically.

## Path B — Railway

Also simple, though the database connection needs a couple of manual
variable references since there's no blueprint file for it here.

1. Push this project to a GitHub repo.
2. [railway.com](https://railway.com) → **New Project → Deploy from GitHub
   repo** → select your repo. The first build will fail (no database yet) -
   that's expected.
3. **+ New → Database → PostgreSQL** in the same project.
4. Click your **app service** (not Postgres) → **Variables** tab → **Add
   Reference Variable**, and add:
   ```
   PGHOST     → Postgres.PGHOST
   PGPORT     → Postgres.PGPORT
   PGDATABASE → Postgres.PGDATABASE
   PGUSER     → Postgres.PGUSER
   PGPASSWORD → Postgres.PGPASSWORD
   ```
   (Or, simpler: add one reference for `DATABASE_URL → Postgres.DATABASE_URL`
   instead of the five above - `config/db.js` accepts either style.)
5. Add the rest manually in the same Variables tab:
   ```
   NODE_ENV=production
   JWT_EXPIRES_IN=8h
   BOOTSTRAP_ADMIN_EMAIL=<your real admin email>
   BOOTSTRAP_ADMIN_PASSWORD=<a strong password>
   JWT_SECRET=<generate one - see below>
   ```
   Generate `JWT_SECRET` locally:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
6. Railway auto-redeploys once variables are saved. Check **Deploy Logs** for
   `School Management System API running...`.
7. **Settings → Networking → Generate Domain** for a public URL.
8. Same ephemeral-filesystem caveat as Render applies here too: **Settings →
   Volumes → New Volume**, mount at `/app/uploads`, and add
   `UPLOADS_DIR=/app/uploads` as another variable, if you want uploads to
   survive redeploys.

No CLI and no separate migrate/seed step needed here either - `npm start`
handles it the same way on every platform.

## Path C — Your own VPS (full control, no ephemeral-filesystem caveat)

Use this if you already have a server, want everything self-hosted, or want
uploaded files on a normal persistent disk without extra configuration.

```bash
# Node, Postgres, Nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql postgresql-contrib nginx

# Database
sudo -u postgres psql -c "CREATE USER schoolapp WITH PASSWORD 'pick-a-strong-password';"
sudo -u postgres psql -c "CREATE DATABASE school_management OWNER schoolapp;"

# Code
git clone <your-repo-url> /var/www/school-management
cd /var/www/school-management
npm install --production
cp .env.example .env
nano .env   # PGHOST=localhost, PGUSER=schoolapp, PGPASSWORD=<from above>,
            # a freshly generated JWT_SECRET, real admin email/password

# Run it (npm start auto-migrates and seeds on this and every future boot)
sudo npm install -g pm2
pm2 start npm --name school-management -- start
pm2 save
pm2 startup   # follow the printed instructions to enable on boot
```

Then put Nginx in front of it as a reverse proxy and add free HTTPS:

```nginx
# /etc/nginx/sites-available/school-management
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/school-management /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com

sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## Before you consider it "live" (any path)

- [ ] `JWT_SECRET` is a freshly generated or platform-generated value, never the placeholder from `.env.example`
- [ ] `BOOTSTRAP_ADMIN_PASSWORD` was changed after your first real login (no in-app UI for this yet - update it directly in the database, or add a change-password endpoint)
- [ ] `NODE_ENV=production`
- [ ] `.env` is not committed to Git (already in `.gitignore`)
- [ ] `cors()` in `server.js` currently allows all origins - fine for this single-domain deployment, but restrict it (`cors({ origin: 'https://your-domain.com' })`) if you ever split the frontend onto a different domain
- [ ] Database backups are scheduled - Render/Railway's managed Postgres both offer this; on a VPS, a `pg_dump` cron job
- [ ] You've logged in once end-to-end on the live URL and confirmed you can create a class/student
- [ ] If uploaded documents/photos matter to you, you've addressed the ephemeral-filesystem caveat (Path A/B) or you're on a VPS (Path C, no caveat)

## Updating after this initial deploy

- **Render / Railway**: `git push` to your connected branch - auto-deploys.
- **VPS**: `git pull`, `npm install` if dependencies changed, then `pm2 restart school-management`.

Schema changes need nothing extra on any path - every statement in
`schema.sql` uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
EXISTS`, and `npm start` re-applies it on every boot.
