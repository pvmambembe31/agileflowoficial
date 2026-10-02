#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-/tmp/agileflow-server-only}"
test "$(id -u)" -eq 0 || { echo 'Execute este instalador com sudo.' >&2; exit 1; }
test -s "$SOURCE/agileflow_server.py"
test -s "$SOURCE/update_webapp.sh"
python3 -m py_compile "$SOURCE/agileflow_server.py"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p /srv/agileflow/backups /usr/local/lib/agileflow
cp -a /srv/agileflow/workspace.json "/srv/agileflow/backups/pre-server-only-$STAMP.json"
cp -a /usr/local/lib/agileflow/agileflow_server.py "/srv/agileflow/backups/server-before-$STAMP.py"
cp -a /usr/local/lib/agileflow/update_webapp.sh "/srv/agileflow/backups/updater-before-$STAMP.sh"
install -m 755 "$SOURCE/agileflow_server.py" /usr/local/lib/agileflow/agileflow_server.py
install -m 755 "$SOURCE/update_webapp.sh" /usr/local/lib/agileflow/update_webapp.sh
systemctl restart agileflow-home-server.service
systemctl is-active --quiet agileflow-home-server.service
echo 'SERVER_ONLY_API_OK'
