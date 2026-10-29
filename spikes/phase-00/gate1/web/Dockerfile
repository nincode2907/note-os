FROM node:22.21.1-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22.21.1-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.21.1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/sync-server/auth.mjs /app/sync-server/http.mjs /app/sync-server/storage.mjs /app/sync-server/media-http.mjs /app/sync-server/media-storage.mjs /app/sync-server/cli.mjs ./sync-server/
COPY --from=build /app/sync-server/migrations ./sync-server/migrations
# On-demand AI Organize worker (sync-server/ai-worker.mjs) and its runtime imports.
COPY --from=build /app/sync-server/ai-foundation.mjs /app/sync-server/ai-control.mjs /app/sync-server/ai-http.mjs /app/sync-server/ai-provider-gateway.mjs /app/sync-server/ai-suggestions.mjs /app/sync-server/ai-taxonomy.mjs /app/sync-server/ai-worker.mjs /app/sync-server/ai-maintenance.mjs /app/sync-server/ai-migrate.mjs /app/sync-server/ai-pilot-preflight.mjs ./sync-server/
COPY --from=build /app/app/lib/note-validation.mjs /app/app/lib/note-organization.mjs ./app/lib/
COPY --from=build /app/packages/document-engine/src ./packages/document-engine/src
COPY --from=build /app/app/lib/sync-protocol.mjs /app/app/lib/audio-anchors.mjs /app/app/lib/audio-sync-protocol.mjs ./app/lib/
RUN mkdir -p /var/lib/noteos-sync && chown -R node:node /var/lib/noteos-sync /app/.next
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
