#!/usr/bin/env bash
#
# bootstrap-vps.sh — Provision Domo sur le VPS (Node + systemd, pas de Docker).
#
# Idempotent : peut être relancé sans casser un déploiement existant.
# Hypothèses :
#  - Debian/Ubuntu (apt-get disponible)
#  - Caddy déjà en service systemd, écoute sur 80/443
#  - L'utilisateur courant est laurent et peut sudo (mot de passe interactif
#    accepté pour ce premier run ; ensuite la règle sudoers domo-deploy
#    installée plus bas suffira pour les deploys automatisés)
#
# Usage : bash scripts/bootstrap-vps.sh
#         curl -fsSL https://raw.githubusercontent.com/LaurentFrx/Domo/main/scripts/bootstrap-vps.sh | bash

set -euo pipefail

REPO_URL="https://github.com/LaurentFrx/Domo.git"
TARGET_DIR="/home/laurent/domo"
DOMAIN="domo.feroux.fr"
SERVICE_NAME="domo"
UNIT_DST="/etc/systemd/system/$SERVICE_NAME.service"
SUDOERS_DST="/etc/sudoers.d/domo-deploy"
NODE_SETUP_URL="https://deb.nodesource.com/setup_lts.x"

log()  { printf '\033[1;34m[domo]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[domo]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[domo]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. Sanity checks ─────────────────────────────────────────────
command -v apt-get >/dev/null 2>&1 || fail 'apt-get introuvable — ce script suppose un VPS Debian/Ubuntu.'
command -v curl >/dev/null 2>&1 || fail 'curl introuvable.'
command -v git  >/dev/null 2>&1 || fail 'git introuvable.'

# ── 1. Node 20+ (install via NodeSource si absent/trop ancien) ───
NEED_NODE_INSTALL=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE_INSTALL=1
  log 'Node absent — installation via NodeSource'
else
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -lt 20 ]; then
    NEED_NODE_INSTALL=1
    log "Node $NODE_MAJOR detecté — upgrade vers LTS via NodeSource"
  else
    log "  Node $(node --version) OK"
  fi
fi
if [ "$NEED_NODE_INSTALL" -eq 1 ]; then
  curl -fsSL "$NODE_SETUP_URL" | sudo -E bash -
  sudo apt-get install -y nodejs
  log "  Node $(node --version) installé"
fi

# ── 2. pnpm (install global via npm si absent) ───────────────────
if ! command -v pnpm >/dev/null 2>&1; then
  log 'pnpm absent — installation via npm -g'
  sudo npm install -g pnpm
fi
log "  pnpm $(pnpm --version) OK"

# ── 3. Caddy systemd ─────────────────────────────────────────────
if systemctl is-active --quiet caddy 2>/dev/null; then
  log '  Caddy systemd actif'
else
  warn 'Caddy systemd inactif. Le service domo démarrera mais HTTPS ne fonctionnera pas tant que Caddy ne sert pas domo.feroux.fr.'
fi

# ── 4. Clone ou pull du repo ─────────────────────────────────────
if [ -d "$TARGET_DIR/.git" ]; then
  log "Repo déjà cloné dans $TARGET_DIR — git pull"
  git -C "$TARGET_DIR" pull --ff-only origin main
else
  log "Clone $REPO_URL → $TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

# ── 5. Install + build ───────────────────────────────────────────
log 'pnpm install --frozen-lockfile'
pnpm install --frozen-lockfile

log 'pnpm build'
pnpm build

# ── 6. .env (warn si absent) ─────────────────────────────────────
if [ ! -f "$TARGET_DIR/.env" ]; then
  warn ''
  warn '.env absent — /api/solcast/forecast renverra 503 tant que ces variables'
  warn 'ne sont pas définies dans /home/laurent/domo/.env :'
  warn '    SOLCAST_API_KEY=...'
  warn '    SOLCAST_RESOURCE_ID=...'
  warn 'Après création :  sudo systemctl restart domo'
  warn ''
fi

# ── 7. Installation du systemd unit ──────────────────────────────
log "Installation systemd unit → $UNIT_DST"
sudo cp "$TARGET_DIR/deploy/domo.service" "$UNIT_DST"
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
  warn "  ✗ $SERVICE_NAME inactif — diagnostic : journalctl -u $SERVICE_NAME -n 30 --no-pager"
fi

# ── 8. Sudoers narrow pour le déploiement automatisé ─────────────
log "Installation sudoers narrow → $SUDOERS_DST"
SUDOERS_LINE='laurent ALL=(root) NOPASSWD: /bin/systemctl restart domo, /bin/systemctl reload caddy'
echo "$SUDOERS_LINE" | sudo tee "$SUDOERS_DST" >/dev/null
sudo chmod 0440 "$SUDOERS_DST"
if sudo visudo -cf "$SUDOERS_DST" >/dev/null 2>&1; then
  log "  ✓ règle sudoers valide"
else
  sudo rm -f "$SUDOERS_DST"
  fail "Sudoers domo-deploy invalide (visudo a refusé). Fichier supprimé pour sécurité."
fi

# ── 9. Bloc Caddyfile à ajouter manuellement ─────────────────────
CADDY_FILE='/etc/caddy/Caddyfile'
if [ -f "$CADDY_FILE" ] && grep -q "^${DOMAIN}" "$CADDY_FILE"; then
  log "Bloc $DOMAIN déjà présent dans $CADDY_FILE — rien à ajouter"
else
  cat <<EOF

================================================================================
  ACTION MANUELLE REQUISE — ajouter ce bloc à $CADDY_FILE
  Puis :  sudo systemctl reload caddy
--------------------------------------------------------------------------------
$DOMAIN {
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
    header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
}
================================================================================

EOF
fi

# ── 10. Vérification finale ──────────────────────────────────────
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
  warn '    Causes possibles : DNS pas propagé, bloc Caddy pas encore ajouté,'
  warn "    ou Let's Encrypt en cours de provisioning (~30s après reload caddy)."
fi

log ''
log 'Bootstrap terminé.'
