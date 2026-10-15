# One image for the API and the worker; docker-compose.yml picks the command.
# Build:  docker compose build      Run: docker compose up -d

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npx tsc -b && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# The worker scans tenants through the Datasphere CLI (list and read only; see packages/connector/src/readonly.ts).
RUN npm install -g @sap/datasphere-cli@2026.21.0 && npm cache clean --force
COPY --from=build /app /app
USER node
CMD ["node", "apps/api/dist/server.js"]
