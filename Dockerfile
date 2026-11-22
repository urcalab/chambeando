# Imagen del backend de Chambeando: servidor HTTP y corrida horaria en un solo proceso.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production NODE_NO_WARNINGS=1

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund

# El modelo de embeddings (unos 135 MB) se descarga al construir la imagen, para que el servidor no dependa de
# Hugging Face al arrancar. Va antes de copiar el resto del código, así la capa queda en caché mientras embed.ts y
# las dependencias no cambien. Hugging Face limita a los runners de GitHub (429): se reintenta con espera.
COPY src/embed.ts ./src/embed.ts
RUN for i in 1 2 3 4 5; do \
      node -e 'import("./src/embed.ts").then(async (m) => { await m.localEmbedder(["prueba"], "query"); })' && exit 0; \
      echo "descarga del modelo falló (intento $i), reintentando"; sleep $((i * 20)); \
    done; exit 1

COPY src ./src
COPY scripts ./scripts
COPY site ./site

# La base SQLite vive en un volumen (config/deploy.yml).
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 8787
CMD ["node", "src/server.ts"]
