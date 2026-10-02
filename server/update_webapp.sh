#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/pvmambembe31/agileflowoficial.git"
BASE="/opt/agileflow"
DEST="$BASE/web"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 "$REPO" "$TMP/repo" >/dev/null 2>&1
if ! python3 - "$TMP/repo/agileflow-manifest.json" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
data = json.loads(p.read_text(encoding='utf-8'))
if data.get('releaseChannel') != 'stable' or data.get('storageMode') != 'server':
    raise SystemExit('Publicação ignorada: aguardo versão estável para servidor.')
PY
then
    exit 0
fi
grep -q 'API_BASE_URL' "$TMP/repo/app.js"
test -s "$TMP/repo/index.html"
test -s "$TMP/repo/styles.css"

mkdir -p "$BASE"
rm -rf "$BASE/web.next"
mkdir "$BASE/web.next"
cp -a "$TMP/repo/." "$BASE/web.next/"
rm -rf "$BASE/web.next/.git"
chown -R root:root "$BASE/web.next"
find "$BASE/web.next" -type d -exec chmod 755 {} \;
find "$BASE/web.next" -type f -exec chmod 644 {} \;

rm -rf "$BASE/web.previous"
if test -d "$DEST"; then mv "$DEST" "$BASE/web.previous"; fi
mv "$BASE/web.next" "$DEST"
if ! systemctl restart agileflow-home-server.service || ! systemctl is-active --quiet agileflow-home-server.service; then
    rm -rf "$DEST"
    if test -d "$BASE/web.previous"; then mv "$BASE/web.previous" "$DEST"; fi
    systemctl restart agileflow-home-server.service || true
    echo 'Atualização revertida: servidor não iniciou.' >&2
    exit 1
fi
echo 'AgileFlow servidor atualizado a partir do GitHub.'
