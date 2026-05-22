#!/usr/bin/env bash
#
# bootstrap-vps.sh — Provision Domo sur le VPS (déploiement Node + systemd).
#
# Idempotent : peut être relancé sans casser un déploiement existant.
# Pas de Docker : SvelteKit adapter-node + systemd + Caddy systemd partagé.
#
# Usage : bash scripts/bootstrap-vps.sh
#         curl -fsSL https://raw.githubusercontent.com/LaurentFrx/Domo/main/scripts/bootstrap-vps.sh | bash

set -euo pipefail

REPO_URL="https://github.com/LaurentFrx/Domo.git"
TARGET_DIR="/home/laurent/domo"
DOMAIN="domo.feroux.fr"
SERVICE_NAME="domo"
UNIT_SRC="$TARGET_DIR/deploy/domo.service"
UNIT_DST="/etc/systemd/system/$SERVICE_NAME.service"

log()  { printf '\033[1;34m[domo]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[domo]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[domo]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Prérequis ─────────────────────────────────────────────────
log 'Vérification Node 20+ / pnpm / Caddy systemd…'

command -v node >/dev/null 2>&1 || fail 'Node introuvable. Installer Node 20+ avant de relancer ce script.'
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node $NODE_MAJOR détecté — Node 20+ requis."
fi
log "  Node $(node --version)"

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    log '  pnpm absent — activation via corepack'
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || fail 'corepack enable a échoué. Installer pnpm manuellement.'
  else
    fail 'pnpm introuvable et corepack absent. Installer pnpm manuellement.'
  fi
fi
log "  pnpm $(pnpm --version)"

if ! systemctl is-active --quiet caddy 2>/dev/null; then
  warn 'Caddy systemd ne tourne pas. Le script continue mais HTTPS ne fonctionnera pas tant que Caddy ne sert pas domo.feroux.fr.'
else
  log '  Caddy systemd actif'
fi

# ── 2. Clone ou pull du repo ─────────────────────────────────────
if [ -d "$TARGET_DIR/.git" ]; then
  log "Repo déjà cloné dans $TARGET_DIR — git pull"
  git -C "$TARGET_DIR" pull --ff-only origin main
else
  log "Clone $REPO_URL → $TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

# ── 3. Install + build ───────────────────────────────────────────
log 'pnpm install --frozen-lockfile'
pnpm install --frozen-lockfile

log 'pnpm build'
pnpm build

# ── 4. .env (placeholder + warn si vide) ─────────────────────────
if [ ! -f "$TARGET_DIR/.env" ]; then
  warn ''
  warn '┌─ .env absent ──────────────────────────────────────────────────'
  warn '│  Le service tournera mais l’endpoint /api/solcast/forecast'
  warn "│  renverra 503 tant que ces variables ne sont pas définies :"
  warn '│'
  warn '│    SOLCAST_API_KEY=...'
  warn '│    SOLCAST_RESOURCE_ID=...'
  warn '│'
  warn "│  Créer $TARGET_DIR/.env puis : sudo systemctl restart $SERVICE_NAME"
  warn '└────────────────────────────────────────────────────────────────'
  warn ''
fi

# ── 5. Installation du systemd unit ──────────────────────────────
log "Installation systemd unit → $UNIT_DST (sudo requis)"
sudo cp "$UNIT_SRC" "$UNIT_DST"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

if systemctl is-active --quiet "$SERVICE_NAME"; then
  log "Restart $SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
else
  log "Start $SERVICE_NAME"
  sudo systemctl start "$SERVICE_NAME"
fi

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  log "  ✓ $SERVICE_NAME actif"
else
  warn "  ✗ $SERVICE_NAME inactif"
  warn '    Diagnostic : journalctl -u domo -n 30 --no-pager'
fi

# ── 6. Bloc Caddyfile à ajouter manuellement ─────────────────────
CADDY_FILE='/etc/caddy/Caddyfile'
if [ -f "$CADDY_FILE" ] && grep -q "^${DOMAIN}" "$CADDY_FILE"; then
  log "Bloc $DOMAIN déjà présent dans $CADDY_FILE — rien à ajouter"
else
  warn ''
  warn '┌─ ACTION MANUELLE REQUISE ──────────────────────────────────────'
  warn "│  Ajouter ce bloc à $CADDY_FILE puis :"
  warn '│    sudo systemctl reload caddy'
  warn '│'
  warn "│    $DOMAIN {"
  warn '│        encode gzip zstd'
  warn '│        reverse_proxy 127.0.0.1:3000'
  warn '│        header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"'
  warn '│    }'
  warn '└────────────────────────────────────────────────────────────────'
  warn ''
fi

# ── 7. Vérification finale ───────────────────────────────────────
log 'Test HTTP local sur 127.0.0.1:3000 …'
if curl -sI --max-time 5 http://127.0.0.1:3000/ >/dev/null 2>&1; then
  log '  ✓ service répond en local'
else
  warn "  ✗ 127.0.0.1:3000 injoignable — voir journalctl -u $SERVICE_NAME -n 30"
fi

log "Test HTTPS sur https://$DOMAIN …"
if curl -sI --max-time 10 "https://$DOMAIN" >/dev/null 2>&1; then
  log "  ✓ https://$DOMAIN répond"
  curl -sI "https://$DOMAIN" | head -3 | sed 's/^/    /'
else
  warn "  ✗ https://$DOMAIN injoignable pour l’instant."
  warn '    Causes possibles :'
  warn "    - DNS pas encore propagé ($DOMAIN → IP du VPS)"
  warn "    - Bloc Caddy pas encore ajouté (cf. instructions ci-dessus)"
  warn "    - Let's Encrypt en cours de provisioning (attendre ~30s après reload Caddy)"
fi

log ''
log 'Bootstrap terminé.'
