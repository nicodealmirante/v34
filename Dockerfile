FROM node:20-alpine

WORKDIR /app

# Necesario para deps que vienen de Git
RUN apk add --no-cache git ca-certificates \
 && git config --global url."https://github.com/".insteadOf "git@github.com:"

COPY package*.json ./

# Usá ci para builds reproducibles (podés dejar install si querés)
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
EXPOSE 3000
CMD ["node","app.js"]
