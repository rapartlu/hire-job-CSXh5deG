# node:20-slim (Debian) avoids Alpine/musl prebuilt issues with better-sqlite3
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./
COPY deliveroo-query.js ./
COPY public/ ./public/

ENV PORT=3000
ENV DB_PATH=/data/captures.db

EXPOSE 3000

CMD ["node", "server.js"]
