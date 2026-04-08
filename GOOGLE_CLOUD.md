# Google Cloud Deployment

This backend can run on Google Cloud with two Cloud Run services:

- `mailgun-api` for the Express API
- `mailgun-worker` for the BullMQ worker

Use Cloud SQL for PostgreSQL and Memorystore for Redis.

## Recommended architecture

- Cloud Run service: API
- Cloud Run service: Worker
- Cloud SQL for PostgreSQL
- Memorystore for Redis
- Secret Manager for application secrets
- Artifact Registry for container images
- Serverless VPC Access connector for private access to Cloud SQL / Memorystore

## 1. Enable Google Cloud APIs

Enable these APIs in your project:

- Cloud Run
- Cloud Build
- Artifact Registry
- Cloud SQL Admin
- Secret Manager
- Memorystore for Redis
- Serverless VPC Access

## 2. Create PostgreSQL on Cloud SQL

1. Create a PostgreSQL instance.
2. Create a database for this app.
3. Create a database user.
4. Decide how the app will connect:
   - Private IP with Serverless VPC Access, or
   - Cloud SQL connector / socket path

Set `DATABASE_URL` accordingly, for example:

```text
postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
```

## 3. Create Redis on Memorystore

1. Create a Memorystore Redis instance in the same region.
2. Connect Cloud Run to the VPC network with a Serverless VPC Access connector.
3. Set `REDIS_URL` to the Redis host and password if required.

Example:

```text
redis://:PASSWORD@REDIS_HOST:6379
```

If your Redis instance uses TLS or a private endpoint, adjust the URL to match that setup.

## 4. Store secrets in Secret Manager

Create secrets for:

- `MAILGUN_API_KEY`
- `MAILGUN_DOMAIN`
- `MAILGUN_FROM`
- `CAMPAIGN_TOKEN_SECRET`
- `WEBHOOK_SECRET` if you use webhook verification

You can also store `DATABASE_URL` and `REDIS_URL` there instead of plain environment variables.

## 5. Build and push the container image

From `backend_maily`:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud auth configure-docker REGION-docker.pkg.dev
gcloud artifacts repositories create mailgun-app --repository-format=docker --location=REGION
gcloud builds submit --tag REGION-docker.pkg.dev/YOUR_PROJECT_ID/mailgun-app/backend:latest
```

## 6. Deploy the API service

Create the Cloud Run API service from the container image.

Suggested settings:

- Region: your preferred region
- Service name: `mailgun-api`
- Memory: 512 MiB or higher
- CPU: 1
- Container port: `8080`
- Ingress: public
- Min instances: 0 or 1 depending on latency needs

Set environment variables:

```text
NODE_ENV=production
PORT=8080
DATABASE_URL=...
REDIS_URL=...
MAILGUN_API_KEY=...
MAILGUN_DOMAIN=...
MAILGUN_FROM=...
CAMPAIGN_TOKEN_SECRET=...
CAMPAIGN_TOKEN_EXPIRES_IN=7d
WEBHOOK_SECRET=...
CRON_DELETE_AFTER_DAYS=30
EMAIL_WORKER_CONCURRENCY=40
EMAIL_RATE_LIMIT_MAX=100
EMAIL_RATE_LIMIT_DURATION_MS=1000
RUN_WORKER_IN_API=false
```

If Cloud SQL and Memorystore are private, attach the VPC connector to this service.

## 7. Deploy the worker service

Deploy the same image as a second Cloud Run service, but override the start command to:

```bash
npm run worker
```

Suggested settings:

- Service name: `mailgun-worker`
- Memory: 512 MiB or higher
- CPU: 1
- Container port: `8080`
- Min instances: 1
- Max instances: 1
- Ingress: internal or public, depending on your setup

Required environment variables are the same as the API service, plus:

```text
WORKER_HTTP_PORT=8080
```

The worker now exposes a small `/health` endpoint so Cloud Run can keep the container alive while BullMQ processes jobs.

## 8. Run database migrations

Run migrations once before traffic goes live:

```bash
npm run migrate
```

Run this from a machine that can reach Cloud SQL, or use a one-off Cloud Run Job / Cloud Shell session with the same environment variables.

## 9. Configure Mailgun webhooks

Point Mailgun webhooks to the public API service URL:

```text
https://YOUR_CLOUD_RUN_API_URL/webhooks/mailgun
```

## 10. Update the desktop frontend

Set the frontend API URL to the Cloud Run API URL in:

- `frontend/.env.local`
- desktop app settings, if you use saved settings

Example:

```text
VITE_API_URL=https://YOUR_CLOUD_RUN_API_URL
```

## 11. Validate

Check the API health endpoint:

```bash
curl https://YOUR_CLOUD_RUN_API_URL/health
```

Then upload a CSV and confirm the worker starts sending jobs.

## Notes

- Cloud Run is a better fit for the API than for a queue worker, so the worker service should stay at `min instances = 1`.
- If you want to minimize cost, you can start the worker manually only when you need it, but BullMQ delivery will pause while the worker is stopped.