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

FROM node:22.21.1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/sync-server/auth.mjs /app/sync-server/http.mjs /app/sync-server/storage.mjs /app/sync-server/cli.mjs ./sync-server/
COPY --from=build /app/sync-server/migrations ./sync-server/migrations
COPY --from=build /app/app/lib/sync-protocol.mjs ./app/lib/sync-protocol.mjs
RUN mkdir -p /var/lib/noteos-sync && chown -R node:node /var/lib/noteos-sync /app/.next
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
