FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copy source
COPY . .

# Dummy secrets for the sandbox. The `initialize` MCP call succeeds without
# real secrets. Tools that require HMAC_SECRET or WP_SHARED_SECRET return a
# clear error message, which is the expected behaviour in a check environment.
ENV HMAC_SECRET="sandbox-hmac-secret-not-used-for-real-bookings"
ENV WP_SHARED_SECRET="sandbox-wp-secret-not-used-for-real-bookings"

EXPOSE 8787

# `wrangler dev --local` runs the worker locally without needing a Cloudflare
# account. The local emulated KV is fine for introspection checks.
CMD ["npx", "wrangler", "dev", "--local", "--ip", "0.0.0.0", "--port", "8787"]
