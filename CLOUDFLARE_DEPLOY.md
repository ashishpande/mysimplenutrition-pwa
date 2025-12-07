# Deploy Frontend to Cloudflare Pages

## Quick Deploy via Dashboard (Recommended)

### Step 1: Push to GitHub
```bash
cd /Users/ashishpande/Documents/softwaredev/nutritionapp
git add .
git commit -m "Add deployment configs"
git push
```

### Step 2: Deploy on Cloudflare
1. Go to https://dash.cloudflare.com
2. Click **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. Select your GitHub repository: `nutritionapp`
4. Configure build settings:
   - **Project name**: `nutrition-pwa`
   - **Production branch**: `main` (or your default branch)
   - **Build command**: (leave empty)
   - **Build output directory**: `/` (leave as root)
   - **Root directory**: `frontend/pwa`
5. Click **Save and Deploy**

### Step 3: Update Backend CORS
After deployment, get your Cloudflare Pages URL (e.g., `https://nutrition-pwa.pages.dev`) and update backend:

```bash
cd /Users/ashishpande/Documents/softwaredev/nutritionapp

# Update CORS to include your Cloudflare URL
flyctl secrets set ALLOWED_ORIGINS="https://nutrition-pwa.pages.dev,https://nutrition-api-spring-dust-1526.fly.dev,http://localhost:4000,http://localhost:5173" --app nutrition-api-spring-dust-1526
```

## Alternative: Direct Upload (No Git Required)

If you don't want to use Git, you can use Cloudflare's direct upload:

1. Go to https://dash.cloudflare.com
2. Click **Workers & Pages** → **Create application** → **Pages** → **Upload assets**
3. Drag and drop the `frontend/pwa` folder
4. Click **Deploy site**

## Verify Deployment

1. Visit your Cloudflare Pages URL
2. Register/login to test the app
3. Log a meal to verify backend connection
4. Check browser console for any CORS errors

## Custom Domain (Optional)

1. In Cloudflare Pages dashboard, go to your project
2. Click **Custom domains** → **Set up a custom domain**
3. Enter your domain (e.g., `nutrition.yourdomain.com`)
4. Follow DNS instructions
5. Update backend CORS to include your custom domain

## Troubleshooting

### CORS Errors
- Verify backend ALLOWED_ORIGINS includes your Cloudflare URL
- Check browser console for exact error
- Test backend directly: `curl https://nutrition-api-spring-dust-1526.fly.dev/api/health`

### API Not Responding
- Verify API_BASE in `index.html` points to correct Fly.io URL
- Check Fly.io backend is running: `flyctl status --app nutrition-api-spring-dust-1526`

### Service Worker Issues
- Clear browser cache and service workers
- Check Application tab in DevTools → Service Workers
- Unregister old service workers if needed
