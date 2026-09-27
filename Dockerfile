FROM node:24-alpine

RUN apk add --no-cache su-exec tini

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/fyle-entrypoint
RUN chmod +x /usr/local/bin/fyle-entrypoint && mkdir -p /data && chown node:node /data

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "fyle-entrypoint"]
CMD ["node", "src/server.js"]
