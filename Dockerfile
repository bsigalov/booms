FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY oref-alerts.mjs .
CMD ["node", "oref-alerts.mjs"]
