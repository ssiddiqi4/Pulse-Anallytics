FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY examples ./examples
COPY sites.json ./sites.json.example

RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV PORT=4000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    SITES_FILE=/data/sites.json

EXPOSE 4000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
