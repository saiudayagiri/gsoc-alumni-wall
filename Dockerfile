# GSoC Alumni Badge Wall — Node/Express server (static pages + /api routes).
# Data lives in Supabase; this container is stateless and horizontally scalable.
#
#   docker build -t ghcr.io/saiudayagiri/gsoc-alumni-wall:v1 .
#   docker run -p 8080:8080 --env-file .env.local ghcr.io/saiudayagiri/gsoc-alumni-wall:v1
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# app code (mini.html is gitignored but present locally — build from the repo dir)
COPY . .

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
