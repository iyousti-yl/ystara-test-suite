# One image for the API (which also serves the web app) and the worker; docker-compose.yml picks the command.
# Build:  docker compose build      Run: docker compose up -d

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npm run build

# The build with its dev packages and the tools, for one-off admin commands on a server
# (npm run account:create, operator:grant). Built only when asked for: deploy/docker-compose.prod.yml, service "tools".
FROM build AS tools
COPY tools ./tools

# The web app is bundled into apps/web/dist; its packages are build-time only and pruned with the rest.
FROM build AS pruned
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# The worker scans tenants through the Datasphere CLI (list and read only; see packages/connector/src/readonly.ts).
RUN npm install -g @sap/datasphere-cli@2026.21.0 && npm cache clean --force
COPY --from=pruned /app /app
USER node
CMD ["node", "apps/api/dist/server.js"]
