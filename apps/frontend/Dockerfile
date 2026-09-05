FROM node:24-alpine AS deps
WORKDIR /app
COPY apps/frontend/package.json apps/frontend/package-lock.json* ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/frontend ./
ENV NEXT_TELEMETRY_DISABLED=1
# Build placeholders only. Compose injects real URLs and tokens at runtime.
ENV ATLAS_ADMIN_API_URL=http://127.0.0.1:8080
ENV ATLASLAB_API_URL=http://127.0.0.1:8090
ENV ATLAS_ADMIN_SERVICE_TOKEN=build-placeholder
ENV ATLASLAB_SERVICE_TOKEN=build-placeholder
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
