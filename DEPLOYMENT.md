# Railway Deployment

Use [RAILWAY.md](RAILWAY.md) for the current deployment setup.

This project runs on Railway as two services:

- `mailgun-api` - Express web service
- `mailgun-worker` - BullMQ worker service

Required shared environment variables:

- `NODE_ENV=production`
- `DATABASE_URL` - provided by Railway Postgres
- `REDIS_URL` - provided by Railway Redis or another Redis provider
- `MAILGUN_API_KEY` - Mailgun private API key
- `MAILGUN_DOMAIN` - verified Mailgun domain
- `MAILGUN_FROM` - sender identity, for example `Mail Team <mail@yourdomain.com>`
- `CAMPAIGN_TOKEN_SECRET` - strong random secret used to sign campaign access tokens
- `CAMPAIGN_TOKEN_EXPIRES_IN=7d`
- `WEBHOOK_SECRET` - optional but recommended for webhook verification
- `CRON_DELETE_AFTER_DAYS=30`
- `EMAIL_WORKER_CONCURRENCY=40`
- `EMAIL_RATE_LIMIT_MAX=100`
- `EMAIL_RATE_LIMIT_DURATION_MS=1000`

Railway notes:

- The API service runs `npm start`.
- The worker service runs `npm run worker`.
- The server already reads Railway's injected `PORT`.
- The worker never reads CSV files. Upload parsing happens in the web service and data is inserted directly into PostgreSQL.
- For large imports, Railway may need a larger service size if uploads become memory intensive during CSV parsing.

Suggested frontend flow:

1. Upload CSV with campaign metadata.
2. Save `campaignId` and `campaignToken` from the response.
3. Poll `GET /campaigns/:id/progress` or subscribe to `GET /campaigns/:id/events?campaignToken=...`.
