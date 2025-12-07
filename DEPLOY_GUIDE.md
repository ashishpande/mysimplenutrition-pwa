# Deployment Guide

## Prerequisites
- Fly.io CLI: `brew install flyctl` or `curl -L https://fly.io/install.sh | sh`
- Cloudflare account (free tier)
- Neon database already set up (from .secrets.sh)

## 1. Deploy Backend to Fly.io

```bash
cd backend/api

# Login to Fly.io
flyctl auth login

# Deploy (app already exists: nutrition-api-spring-dust-1526)
flyctl deploy

# Set secrets (run from repo root)
bash .secrets.sh

# Verify deployment
flyctl status
flyctl logs

# Test health endpoint
curl https://nutrition-api-spring-dust-1526.fly.dev/api/health
```

## 2. Deploy Frontend to Cloudflare Pages

### Option A: Via Cloudflare Dashboard (Recommended)
1. Go to https://dash.cloudflare.com
2. Navigate to Workers & Pages → Create application → Pages → Connect to Git
3. Select your repository
4. Configure build settings:
   - Build command: (leave empty)
   - Build output directory: `frontend/pwa`
   - Root directory: `frontend/pwa`
5. Click "Save and Deploy"

### Option B: Via Wrangler CLI
```bash
cd frontend/pwa

# Install Wrangler
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Deploy
wrangler pages deploy . --project-name=nutrition-pwa
```

## 3. Update CORS Settings

After deploying frontend, update backend CORS to allow your Cloudflare Pages URL:

```bash
# Add your Cloudflare Pages URL to allowed origins
flyctl secrets set ALLOWED_ORIGINS="https://nutrition-pwa.pages.dev,http://localhost:4000,http://localhost:5173" --app nutrition-api-spring-dust-1526
```

## 4. Verify Deployment

1. Backend health: https://nutrition-api-spring-dust-1526.fly.dev/api/health
2. LLM health: https://nutrition-api-spring-dust-1526.fly.dev/api/health/llm
3. Frontend: https://nutrition-pwa.pages.dev (or your custom domain)

## Environment Variables

### Backend (Fly.io)
Already set via .secrets.sh:
- `DATABASE_URL`: Neon PostgreSQL connection string
- `JWT_SECRET`: Secret for JWT token signing
- `GROQ_API_KEY`: Groq API key for LLM
- `SKIP_LLM`: Set to 'false' to enable LLM

Additional optional variables:
- `ALLOWED_ORIGINS`: Comma-separated list of allowed CORS origins
- `OLLAMA_HOST`: Ollama host URL (if using Ollama instead of Groq)
- `OLLAMA_MODEL`: Ollama model name (default: llama3)
- `GROQ_MODEL`: Groq model name (default: llama-3.3-70b-versatile)

### Frontend (Cloudflare Pages)
No environment variables needed - API URL is auto-detected in index.html

## Database Migrations

Migrations run automatically on Fly.io deployment via Dockerfile CMD.

To run manually:
```bash
flyctl ssh console --app nutrition-api-spring-dust-1526
npx prisma migrate deploy
```

## Monitoring & Logs

```bash
# View backend logs
flyctl logs --app nutrition-api-spring-dust-1526

# View metrics
flyctl dashboard --app nutrition-api-spring-dust-1526

# SSH into container
flyctl ssh console --app nutrition-api-spring-dust-1526
```

## Cost Estimate

- **Neon (Database)**: Free tier - 0.5GB storage, 1 project
- **Fly.io (Backend)**: Free tier - 3 shared-cpu-1x VMs, 256MB RAM, auto-stop when idle
- **Cloudflare Pages (Frontend)**: Free tier - Unlimited requests, 500 builds/month
- **Groq (LLM)**: Free tier - Rate limited API access

**Total: $0/month** (within free tiers)

## Troubleshooting

### Backend won't start
- Check logs: `flyctl logs`
- Verify secrets are set: `flyctl secrets list`
- Check database connection: `flyctl ssh console` then test DATABASE_URL

### Frontend can't reach backend
- Verify CORS settings include your frontend URL
- Check API_BASE in index.html points to correct Fly.io URL
- Test backend health endpoint directly

### LLM not working
- Check Groq API key is valid: `flyctl secrets list`
- Test LLM health: `curl https://nutrition-api-spring-dust-1526.fly.dev/api/health/llm`
- Check logs for LLM errors: `flyctl logs`
