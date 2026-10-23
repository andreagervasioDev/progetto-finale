# Immagine unica per il deploy online (Render): ChromaDB, data agent Python e backend Node
# girano nello stesso container e si parlano su 127.0.0.1, come in locale.
# Il backend serve anche il frontend compilato. I dati stanno in /data (permanente solo con un disco).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# dipendenze prima del codice, così Docker riusa la cache quando cambia solo il codice
COPY backend/package.json backend/package-lock.json backend/
RUN npm --prefix backend ci --omit=dev

COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm --prefix frontend ci

COPY data_agent/requirements.txt data_agent/
RUN python3 -m venv data_agent/.venv \
  && data_agent/.venv/bin/pip install --no-cache-dir --upgrade pip \
  && data_agent/.venv/bin/pip install --no-cache-dir -r data_agent/requirements.txt

COPY . .
RUN npm --prefix frontend run build

ENV NODE_ENV=production
CMD ["bash", "deploy/start.sh"]
