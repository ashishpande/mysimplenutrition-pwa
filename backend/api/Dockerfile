FROM node:20-bullseye

WORKDIR /app

# Install deps first for better caching
COPY package*.json ./
RUN npm install --production

# System deps for Prisma (OpenSSL 1.1 on bullseye)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libssl1.1 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Prisma schema and sources
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client at build time
RUN npx prisma generate

ENV PORT=4000 \
    HOST=0.0.0.0

EXPOSE 4000

CMD ["node", "src/server.js"]
