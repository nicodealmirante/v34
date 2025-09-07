FROM node:20-alpine

WORKDIR /app

# Git (para deps desde Git) + certs
RUN apk add --no-cache git ca-certificates

# Si alguna dep usa SSH (git@github.com:...), forzá HTTPS para evitar llaves
RUN git config --global url."https://github.com/".insteadOf "git@github.com:"

# Manifiestos primero (cache de capas)
COPY package*.json ./

# Instalar deps (sin mounts, sin audit/fund)
RUN npm install --omit=dev --no-audit --no-fund

# Código
COPY . .

EXPOSE 3000
CMD ["node","app.js"]
