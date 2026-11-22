# Imagen del backend de Chambeando: servidor HTTP y corrida horaria en un solo proceso.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production NODE_NO_WARNINGS=1

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
COPY site ./site

# El modelo de embeddings (unos 135 MB) se descarga al construir la imagen, para que el servidor
# no dependa de Hugging Face al arrancar o reiniciarse.
RUN node -e 'import("./src/embed.ts").then(async (m) => { await m.localEmbedder(["prueba"], "query"); })'

# La base SQLite vive en un volumen (config/deploy.yml).
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 8787
CMD ["node", "src/server.ts"]
