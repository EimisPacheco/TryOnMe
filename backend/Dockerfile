# Stage 1: Install Node dependencies
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production

# Stage 2: Runtime
FROM node:20-slim
WORKDIR /app

# Install system deps: libvips (for Sharp), Python 3, pip, and Playwright browser deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    python3 \
    python3-pip \
    python3-venv \
    # Playwright Chromium dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Install Python dependencies and Playwright browser
RUN python3 -m pip install --no-cache-dir --break-system-packages -r python-services/requirements.txt \
    && python3 -m playwright install chromium

# Remove dev/local files
RUN rm -rf __tests__ .env .DS_Store python-services/venv

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
