# Render Deployment (Recommended)

This backend runs on Render as two services:

- `mailgun-api` (web service)
- `mailgun-worker` (background worker)

Both use the same codebase under `backend_maily`.

## Fastest setup

1. Push repository to GitHub.
2. In Render dashboard, choose **Blueprint** deployment.
3. Select this repo and deploy using `backend_maily/render.yaml`.
4. Fill secret environment variables when prompted:
   - `MAILGUN_API_KEY`
   - `MAILGUN_DOMAIN`
   - `MAILGUN_FROM`
   - `CAMPAIGN_TOKEN_SECRET`
   - `WEBHOOK_SECRET` (optional)
5. After first deploy, run migration once:

```bash
npm run migrate
```

Use Render Shell on `mailgun-api`, or run migration locally with production env values.

## Required architecture

- PostgreSQL: Render managed database (wired in `render.yaml`)
- Redis: Render managed Redis (wired in `render.yaml`)
- API: `npm start`
- Worker: `npm run worker`

## Mailgun webhook

Set webhook URL in Mailgun:

```text
https://<your-mailgun-api-on-render>/webhooks/mailgun
```

If `WEBHOOK_SECRET` is set, include header:

```text
x-webhook-secret: <your-webhook-secret>
```

## Frontend configuration

Set desktop frontend API URL to the Render API URL:

```text
VITE_API_URL=https://<your-mailgun-api-on-render>
```
