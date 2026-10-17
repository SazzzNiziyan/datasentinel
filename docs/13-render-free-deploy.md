# Deploying on Render's free tier

This is a **demo or personal setup, not a production one**. It runs everything in one free Render web service (web app, API, worker, nginx; see `Dockerfile.render`) with free external services. Use synthetic data only.

## What you get, and the limits

- One address, `https://<name>.onrender.com`, with automatic HTTPS. The web app is at `/` and the API at `/api`, so session cookies work.
- A free Render service sleeps after about 15 minutes without requests, and the worker (scheduled checks, notifications) stops with it. An uptime monitor pinging it every 5 minutes keeps it awake; one always-on service fits the free 750 hours a month.
- 512 MB of memory. The container uses about 310 MB idle.
- **Neon free** suspends its database when idle, but this app polls every few seconds, so the database stays awake and uses the monthly free compute allowance. Watch Neon's usage page; if you run out, switch to another free Postgres (for example Supabase) by changing `DATABASE_URL` and `DIRECT_DATABASE_URL`.
- **Redis Cloud free** allows about 30 connections and 30 MB. If logs show "max number of clients reached", upgrade or tell me and I will reduce connections.
- Check Render's, Neon's, Redis Cloud's and Cloudflare's current free-tier terms: they change.

## Steps

1. **Services.** Have these ready: a Neon database (pooled and direct connection strings), a Redis Cloud database (`redis://default:PASSWORD@host:port`), and a Cloudflare R2 bucket with an API token (access key id, secret, endpoint `https://<account id>.r2.cloudflarestorage.com`).
2. **Pick the address.** Choose a unique service name, for example `datasentinel-yourname`, and set it in `render.yaml` (`name:`). Your address is `https://datasentinel-yourname.onrender.com`.
3. **Push the repository** to GitHub (the Blueprint deploys from a repository). Do not commit `.env`.
4. **Render dashboard:** New, then Blueprint, then pick the repository. Fill in the prompted values:
   - `WEB_ORIGIN` and `OAUTH_CALLBACK_BASE_URL`: both your `https://...onrender.com` address.
   - `DATABASE_URL`: Neon pooled string. `DIRECT_DATABASE_URL`: Neon direct string. Both need `?sslmode=require`.
   - `REDIS_URL`, and the four `S3_` values.
   - Leave `SMTP_URL`, `EMAIL_FROM`, `AI_API_KEY` empty for now.
5. After the first deploy, open **Environment** and copy `SECRETS_ENCRYPTION_KEY` to a password manager.
6. Check `https://<name>.onrender.com/api/health/ready`: it should list database, redis and storage as `up`. The first start applies the database migrations.
7. Open the address, create an account, and create a workspace.
8. **Keep it awake.** At uptimerobot.com add an HTTP monitor for `https://<name>.onrender.com/api/health/live` every 5 minutes.

## Turning on email (optional)

Gmail: turn on 2-step verification, create an app password (Google Account, Security, App passwords), then set

- `SMTP_URL` = `smtps://you%40gmail.com:APPPASSWORD@smtp.gmail.com:465` (write `@` in the address as `%40`; remove spaces from the app password)
- `EMAIL_FROM` = `DataSentinel <you@gmail.com>`

Gmail allows about 500 messages a day. Brevo works the same way with its SMTP settings. Create an email destination in the app and use "send test".

## Turning on AI (optional)

Get a key at aistudio.google.com (Get API key), then set `AI_API_KEY`, set `FEATURE_AI` to `true`, and optionally `AI_MODEL` (default `gemini-2.5-flash`). Then a workspace admin turns AI on in Settings. Google's free tier may use prompts to improve its models, which the disclosure text says. Use synthetic data only.

## Sign-in

Email and password sign-in works. Google and GitHub sign-in are left off (they need OAuth credentials, which need the final address; add them later in the same environment settings).
