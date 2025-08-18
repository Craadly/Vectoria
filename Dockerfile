# ---- Builder: install production dependencies (including native builds) ----
FROM node:20-alpine AS builder
WORKDIR /app

# Build tools only in the builder stage (for native deps if any)
RUN apk add --no-cache --virtual .build-deps python3 make g++ libc6-compat

# Install dependencies using the lockfile
COPY package*.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force

# ---- Runtime: small, secure, correct permissions ---------------------------
FROM node:20-alpine
WORKDIR /app

# Minimal runtime packages
# - tini: proper signal handling (PID 1)
# - ca-certificates: TLS for HTTPS requests
# - potrace: enables local vectorization fallback (optional but useful)
# - libc6-compat: better binary compatibility on Alpine
RUN apk add --no-cache tini ca-certificates potrace libc6-compat && update-ca-certificates

# Environment defaults (can be overridden at runtime)
ENV NODE_ENV=production
ENV PORT=3001
ENV NODE_OPTIONS=--enable-source-maps

# Bring only production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy the rest of the application
COPY . .

# Ensure the unprivileged 'node' user can write to /app/temp
RUN mkdir -p /app/temp && chown -R node:node /app /app/temp

# Drop root
USER node

# Document the port
EXPOSE 3001

# Use tini as init for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start the server
CMD ["node", "server.js"]

# Health check (expects your server to expose /api/health)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
