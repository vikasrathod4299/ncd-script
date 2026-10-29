FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD ["node", "src/bot.js"]
