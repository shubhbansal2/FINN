# One container: the FastAPI backend serves both the API and the built PWA.
FROM node:20-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY data/finn.db data/finn.db
COPY --from=web /web/dist frontend/dist
ENV PYTHONUTF8=1
CMD ["sh", "-c", "uvicorn finn.api:app --app-dir backend --host 0.0.0.0 --port ${PORT:-8000}"]
