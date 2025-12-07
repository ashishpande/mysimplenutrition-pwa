FROM node:20-bullseye-slim

WORKDIR /app

# Install openssl for Prisma engine compatibility and clean up apt cache.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

# Install deps (including dev for prisma generate), generate client, then prune dev deps.
RUN npm ci --include=dev && \
    npx prisma generate && \
    npm prune --omit=dev

COPY src ./src/

EXPOSE 8080

# Run migrations on start, then launch the API.
CMD npx prisma migrate deploy && node src/server.js
