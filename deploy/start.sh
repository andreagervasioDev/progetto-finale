#!/usr/bin/env bash
# Avvio nel container (Render): i tre processi di "npm run dev", con i dati in $DATA_DIR (/data).
# Se uno dei tre si ferma, il container termina e Render lo riavvia.
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/storage" "$DATA_DIR/chroma_data" "$DATA_DIR/datasets" "$DATA_DIR/charts"

# i PNG dei grafici finiscono in /data con gli altri dati
rm -rf /app/data_agent/charts
ln -s "$DATA_DIR/charts" /app/data_agent/charts

/app/backend/node_modules/.bin/chroma run --path "$DATA_DIR/chroma_data" --port "${CHROMA_PORT:-8000}" &
(cd /app/data_agent && exec .venv/bin/python app.py) &
(cd /app/backend && exec node src/server.js) &

# esce appena uno dei tre processi termina
wait -n
echo "Un servizio si è fermato: riavvio del container." >&2
exit 1
