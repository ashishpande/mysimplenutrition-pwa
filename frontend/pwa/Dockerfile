FROM nginx:alpine

# Copy custom Nginx config to proxy API requests to the backend service.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy static PWA assets.
COPY frontend/pwa /usr/share/nginx/html

EXPOSE 80
