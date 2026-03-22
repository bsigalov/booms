FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY oref-alerts.mjs oref-regions-official.json ./
COPY coords-cache.json* ./
CMD ["node", "oref-alerts.mjs"]
