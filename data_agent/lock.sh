#!/bin/sh
# Rigenera i lock delle dipendenze Python (requirements.txt e requirements-dev.txt) dai vincoli in
# requirements.in e requirements-dev.in. Si lancia dalla root con:
#   npm run lock:python                 dopo aver cambiato un vincolo (le altre versioni restano quelle bloccate)
#   npm run lock:python -- --upgrade    per passare alle ultime versioni ammesse dai vincoli
# --universal: un solo lock valido su macOS, Linux (Docker, CI) e Windows, con le dipendenze di ogni sistema.
set -e
cd "$(dirname "$0")"
for name in requirements requirements-dev; do
  .venv/bin/uv pip compile --universal --python-version 3.12 --custom-compile-command "npm run lock:python" \
    --quiet "$@" "$name.in" -o "$name.txt"
done
