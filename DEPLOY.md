# Deployment Guide

## Cost: $0-5/month for 100s of users

### 1. Database (Neon - Free)
```bash
# Sign up at neon.tech
# Create project, enable connection pooling (PgBouncer)
# Copy pooled connection string
export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require&pgbouncer=true"

# Run migrations (one-time)
cd backend/api
npx prisma migrate deploy
npx prisma generate

# Import 800k foods (one-time, ~5 min) - DO NOT run on every deploy
npm run ingest:foods
```

### 2. Backend (Fly.io - 512MB or Railway $5)
```bash
# Install CLI
brew install flyctl

# Login & launch
flyctl auth login
flyctl launch --name nutrition-api --region sjc

# Set secrets (NO secrets in repo/images)
flyctl secrets set \
  DATABASE_URL="postgresql://...?pgbouncer=true" \
  JWT_SECRET="$(openssl rand -base64 32)" \
  GROQ_API_KEY="gsk_..." \
  SKIP_LLM="false" \
  ALLOWED_ORIGINS="https://your-app.pages.dev"

# Deploy
flyctl deploy

# Your API: https://nutrition-api.fly.dev
```

### 3. Frontend (Cloudflare Pages - Free)
```bash
cd frontend/pwa

# Update API_BASE in index.html
# Change: window.API_BASE = "https://nutrition-api.fly.dev/api"

# Deploy
npx wrangler pages deploy . --project-name nutrition-app

# Your PWA: https://nutrition-app.pages.dev
```

### 4. Get Groq API Key (Free)
- Sign up: https://console.groq.com
- Create API key
- Free tier: 30 requests/min (plenty for nutrition lookups)

## Architecture
- **Frontend**: Cloudflare Pages (global CDN, unlimited bandwidth)
- **Backend**: Fly.io 512MB or Railway $5 (connection pooling required)
- **Database**: Neon Postgres with PgBouncer (0.5GB free, 800k food items)
- **LLM**: Groq API (10x faster than Ollama, free tier, set SKIP_LLM=true to disable)

## Important Notes
- **Connection Pooling**: Use Neon's pooled connection string to avoid exhausting connections
- **Food Import**: Run `npm run ingest:foods` ONCE after initial deploy, not on every deploy
- **Secrets**: All via platform env vars, never commit to repo
- **CORS**: Lock ALLOWED_ORIGINS to your frontend URL only

## Monitoring
```bash
# View logs
flyctl logs

# Check status
flyctl status

# Scale if needed (still free)
flyctl scale memory 512
```

## Update Deployment
```bash
# Backend
flyctl deploy

# Frontend
cd frontend/pwa && npx wrangler pages deploy .
```
