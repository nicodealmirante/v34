# syntax=docker/dockerfile:1.7
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache git ca-certificates \
 && git config --global url."https://github.com/".insteadOf "git@github.com:"

COPY package*.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

COPY . .
EXPOSE 3000
CMD ["node","app.js"]
