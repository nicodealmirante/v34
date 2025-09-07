FROM node:20-alpine
# Necesario para deps desde git:
RUN apk add --no-cache git openssh

WORKDIR /app
COPY package*.json ./
# Si no tenés package-lock.json:
RUN npm install --omit=dev --no-audit --no-fund
# (o, si tenés lockfile)
# RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
EXPOSE 8080
CMD ["node","app.js"]
