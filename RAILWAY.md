# Railway Deployment

This project is designed to run on Railway as two services:

- `mailgun-api` for the Express API
- `mailgun-worker` for the BullMQ worker

Use Railway Postgres for `DATABASE_URL` and Railway Redis or another Redis provider for `REDIS_URL`.

The included [railway.toml](railway.toml) configures the API service.

## 1. Create the Railway project

1. Create a new Railway project from this repository.
2. Set the repo root for both services to `backend_maily`.
3. Add a PostgreSQL plugin to the project.
4. Add a Redis plugin or connect an external Redis instance.

## 2. Configure the API service

Service type: Web

Build command:

```bash
npm ci
```

Start command:

```bash
npm start
```

Health check path:

```text
/health
```

Required environment variables:

```text
NODE_ENV=production
DATABASE_URL=<from Railway Postgres>
REDIS_URL=<from Railway Redis>
MAILGUN_API_KEY=<your Mailgun API key>
MAILGUN_DOMAIN=<your verified Mailgun domain>
MAILGUN_FROM=<sender name and address>
CAMPAIGN_TOKEN_SECRET=<strong random secret>
CAMPAIGN_TOKEN_EXPIRES_IN=7d
WEBHOOK_SECRET=<optional webhook secret>
CRON_DELETE_AFTER_DAYS=30
EMAIL_WORKER_CONCURRENCY=40
EMAIL_RATE_LIMIT_MAX=100
EMAIL_RATE_LIMIT_DURATION_MS=1000
```

Railway assigns `PORT` automatically, and the server already reads it.

## 3. Configure the worker service

Service type: Worker

Build command:

```bash
npm ci
```

Start command:

```bash
npm run worker
```

Use the same environment variables as the API service.

If you want Railway config as code for the worker too, create a second Railway service in the dashboard and set its start command to `npm run worker`. Railway applies config per service, so the included `railway.toml` is intentionally scoped to the API service.

### Single-service fallback (optional)

If you are running only one Railway service and recipients stay `pending`, set:

```text
RUN_WORKER_IN_API=true
```

This starts the BullMQ worker inside the API process so queued jobs are consumed without a separate worker service.

## 4. Mailgun webhook URL

Point Mailgun webhooks at your Railway API service:

```text
https://<your-railway-service-domain>/webhooks/mailgun
```

If you use a webhook secret, send it as:

```text
x-webhook-secret: <your secret>
```

## 5. Frontend connection

The desktop frontend should point to the Railway API URL.

Set the frontend API base URL to the deployed Railway service domain, then sign in or upload a campaign using that URL.

## 6. Validate the deployment

Check the live API:

```bash
curl https://<your-railway-service-domain>/health
```

If the API is up, the response should be:

```json
{
	"status": "ok",
	"database": { "status": "ok" },
	"redis": { "status": "ok" },
	"worker": {
		"status": "online",
		"source": "worker",
		"lastSeenAt": "2026-04-07T12:00:00.000Z"
	}
}
```

Then verify that the worker starts and the first campaign send completes successfully.
