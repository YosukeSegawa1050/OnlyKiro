FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 SCHEDULE_DATA_DIR=/app/.schedule-data
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY update.html update-page.js updates.js release.json index.html RoundSchedule.html core.js storage.js shared-storage.js shared-ui.js notifications.js category-interactions.js app.js styles.css ds-sw.js ds-manifest.json icon-192.png icon-512.png schedule-icon.svg ./
RUN mkdir -p /app/.schedule-data && chown node:node /app/.schedule-data
USER node
EXPOSE 8787
VOLUME ["/app/.schedule-data"]
CMD ["node", "server/start.cjs"]
