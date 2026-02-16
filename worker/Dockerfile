FROM node:22-slim

# Install Chromium dependencies + Chromium itself
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use the system Chromium instead of downloading its own
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Copy package files and install deps
COPY container/package.json container/package-lock.json* ./
RUN npm ci --production=false

# Copy source and build
COPY container/tsconfig.json ./
COPY container/src/ ./src/
RUN npx tsc

# Remove dev deps after build
RUN npm prune --production

EXPOSE 3000

ENV PORT=3000

CMD ["node", "dist/server.js"]
