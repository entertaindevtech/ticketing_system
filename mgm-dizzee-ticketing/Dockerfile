# One Railway service: builds the React front-end, then serves it and the FastAPI backend together.
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    FRONTEND_DIST=/app/dist GEOIP_DB_PATH=/data/GeoLite2-City.mmdb
WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
COPY --from=web /app/dist /app/dist
# Migrations run on every deploy (idempotent); then a single uvicorn worker (see handover doc for scaling).
# Client IPs are read from X-Forwarded-For by app/geo.py using TRUSTED_PROXY_HOPS, so uvicorn must not rewrite them.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --no-proxy-headers"]
