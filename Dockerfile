FROM node:22-trixie-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.js database.js postgres-worker.js security.js storage.js enterprise.js provider-adapters.js operations.js network-security.js app.js index.html landing.html privacy.html terms.html api.html styles.css marketing.css enterprise-marketing.css legal.css ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
RUN mkdir -p /app/data /app/backups && chown -R node:node /app
VOLUME ["/app/data", "/app/backups"]
USER node
CMD ["node", "--no-warnings", "server.js"]
