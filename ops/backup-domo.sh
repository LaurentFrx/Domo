#!/usr/bin/env bash
# Sauvegarde Domo — comble l'absence totale de backup pointée par l'audit (R4/V4).
#
# Sauvegarde : data/*.json (réglages, planning, tarifs, état cumulus, abonnements
# push, incidents) + history.db (5 ans de mesures, base du recorder). Copie
# horodatée + rotation. La base SQLite est sauvegardée via l'API .backup (snapshot
# COHÉRENT même pendant que le recorder écrit), jamais un simple cp à chaud.
#
# Installé via deploy/domo-backup.{service,timer} (quotidien). Restauration : voir
# docs/fiabilite.md (un dossier = un instantané complet, autoportant).
set -euo pipefail

SRC_DATA="/home/laurent/domo/data"
SRC_DB="/home/laurent/domo-recorder/history.db"
DEST="/home/laurent/backups/domo"
KEEP=14

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/$STAMP"
mkdir -p "$OUT"

# JSON d'état (petits fichiers) — copie best-effort (certains peuvent manquer).
cp -a "$SRC_DATA"/*.json "$OUT"/ 2>/dev/null || true

# Scripts HORS-GIT du recorder (record.py = seul writer + logique de réconciliation
# anti-perte). Sans ça, le correctif qui EMPÊCHE la perte de données vivrait dans un
# fichier ni versionné ni sauvegardé.
cp -a /home/laurent/domo-recorder/*.py "$OUT"/ 2>/dev/null || true

# Config Zigbee du RPi4 (clé réseau + backup coordinateur + base devices) : sa perte
# = re-pairing de TOUS les capteurs. Best-effort via Tailscale ; ne fait JAMAIS
# échouer la sauvegarde (chaque scp gardé par || true).
mkdir -p "$OUT/zigbee"
for f in configuration.yaml coordinator_backup.json database.db state.json; do
  scp -q -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
    "laurent@100.126.201.4:/home/laurent/docker/zigbee2mqtt/data/$f" \
    "$OUT/zigbee/$f" 2>/dev/null || true
done

# SQLite : snapshot cohérent via l'API backup (pas de cp à chaud).
if [ -f "$SRC_DB" ]; then
  python3 - "$SRC_DB" "$OUT/history.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
with dst:
    src.backup(dst)
dst.close(); src.close()
PY
  gzip -f "$OUT/history.db"
fi

# Rotation : ne conserver que les KEEP instantanés les plus récents.
ls -1dt "$DEST"/*/ 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -rf

echo "[backup-domo] $(date -Is) OK → $OUT"
