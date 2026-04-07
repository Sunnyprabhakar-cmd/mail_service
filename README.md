# Mailgun Bulk Email Backend

Production-ready Node.js backend for bulk campaigns using Express, PostgreSQL, Redis, BullMQ, and Mailgun.

## Features

- Upload recipients via CSV and stream rows directly into PostgreSQL.
- Queue one BullMQ job per recipient with retries and exponential backoff.
- Send personalized HTML emails via Mailgun.
- Track recipient/campaign status from API and webhooks.
- Optional daily cleanup cron for old campaigns.

## Folder Structure

- `controllers/` - Route handlers
- `routes/` - API routes
- `services/` - Reusable business logic and integrations
- `queue/` - Redis/BullMQ setup
- `workers/` - Queue workers for email delivery only
- `db/` - Schema, migrations, and data queries
- `middlewares/` - Upload and error middleware
- `config/` - Environment loading/validation

## Prerequisites

- Node.js 18+
- PostgreSQL
- Redis
- Mailgun account and verified domain

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Create database and run schema migration:

```bash
npm run migrate
```

4. Start API:

```bash
npm run dev
```

5. Start worker (in another terminal):

```bash
npm run worker
```

## API Endpoints

### Upload campaign CSV

`POST /campaigns/upload`

- `multipart/form-data`
- `file`: CSV file with headers `email,name,company`
- body fields: `name`, `subject`, `template`

This endpoint parses the CSV immediately using streaming `csv-parser`, batches recipient inserts into PostgreSQL, and does not persist the CSV file anywhere.

Response also includes `campaignToken`. Save it on frontend and send it in either:

- `Authorization: Bearer <campaignToken>`
- `x-campaign-token: <campaignToken>`

for campaign-scoped endpoints.

Example template:

```html
<h1>Hi {{name}}</h1><p>Welcome to {{company}}</p>
```

### Send campaign (optional manual trigger)

`POST /campaigns/:id/send`

Queues all pending recipients for the campaign.

### Campaign status

`GET /campaigns/:id/status`

Returns `total`, `sent`, `failed`, `pending`.

### Campaign progress (recommended for frontend)

`GET /campaigns/:id/progress`

Returns staged progress that frontend can poll after upload:

- `queued`
- `importing`
- `import_failed`
- `sending`
- `completed`
- `completed_no_recipients`

Example response:

```json
{
  "campaignId": 12,
  "stage": "sending",
  "import": {
    "status": "completed",
    "imported": 20000,
    "invalid": 15,
    "error": null
  },
  "delivery": {
    "total": 20000,
    "sent": 8500,
    "failed": 120,
    "pending": 11380
  }
}
```

### Campaign events stream (SSE)

`GET /campaigns/:id/events`

Use Server-Sent Events for live updates without frontend polling. The stream sends:

- `progress`
- `done`
- `error`

Simple frontend example:

```js
const stream = new EventSource(`/campaigns/${campaignId}/events?campaignToken=${encodeURIComponent(campaignToken)}`);

stream.addEventListener("progress", (event) => {
  const data = JSON.parse(event.data);
  console.log("progress", data);
});

stream.addEventListener("done", (event) => {
  const data = JSON.parse(event.data);
  console.log("done", data);
  stream.close();
});

stream.addEventListener("error", (event) => {
  console.error("stream error", event);
});
```

For non-SSE endpoints, prefer Authorization header. Query token support is mainly for EventSource compatibility.

### Mailgun webhooks

`POST /webhooks/mailgun`

Example payload:

```json
{
  "event": "delivered",
  "recipient": "john@acme.com",
  "campaignId": 1,
  "reason": null
}
```

If `WEBHOOK_SECRET` is configured, send header `x-webhook-secret`.

## Sample CSV

```csv
email,name,company
john@acme.com,John,Acme Inc
jane@globex.com,Jane,Globex
```

## Railway Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) and [RAILWAY.md](RAILWAY.md) for a Railway-ready setup with separate web and worker services.
