# syntax=docker/dockerfile:1
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Зависимости ставим отдельным слоем: он пересобирается только при изменении package*.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Каталог для вложений: в docker-compose на него монтируется именованный том,
# который наследует владельца из образа.
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["node", "src/server.js"]
