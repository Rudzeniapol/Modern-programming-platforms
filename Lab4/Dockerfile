# syntax=docker/dockerfile:1
# Один образ: Node.js отдаёт и статические файлы клиента, и WebSocket — на одном порту.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Зависимости отдельным слоем: пересобираются только при изменении package*.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

USER node
EXPOSE 8092
ENV PORT=8092

CMD ["node", "src/server.js"]
