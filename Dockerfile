# syntax=docker/dockerfile:1.7
FROM node:20-alpine

WORKDIR /app

# Necesario para deps desde Git (evita ENOENT)
RUN apk add --no-cache git ca-certificates \
 && git config --global url."https://github.com/".insteadOf "git@github.com:"

COPY package*.json ./

# Usa npm ci si existe package-lock.json; si no, npm install
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

COPY . .
EXPOSE 3000
CMD ["node","app.js"]
