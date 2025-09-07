FROM node:20-alpine
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 3000
CMD ["node","app.js"]
