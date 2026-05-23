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
SUDOERS_TMP="$(mktemp)"
cat >"$SUDOERS_TMP" <<'SUDOERS'
laurent ALL=(root) NOPASSWD: /bin/systemctl restart domo, /bin/systemctl reload caddy, /usr/bin/caddy validate --config /etc/caddy/Caddyfile
SUDOERS
if sudo visudo -cf "$SUDOERS_TMP" >/dev/null 2>&1; then
  sudo install -m 0440 -o root -g root "$SUDOERS_TMP" "$SUDOERS_DST"
  rm -f "$SUDOERS_TMP"
  log "  ✓ règle sudoers installée et validée"
else
  rm -f "$SUDOERS_TMP"
  fail "Sudoers domo-deploy invalide (visudo a refusé). Aucune modification appliquée."
fi

# ── 9. Caddyfile : ajout idempotent du bloc reverse_proxy ────────
CADDY_FILE='/etc/caddy/Caddyfile'
if ! systemctl is-active --quiet caddy 2>/dev/null; then
  warn "Caddy inactif — skip de la configuration Caddyfile pour $DOMAIN."
elif [ ! -f "$CADDY_FILE" ]; then
  warn "$CADDY_FILE absent — skip (Caddy installé mais sans Caddyfile par défaut ?)"
elif grep -q "$DOMAIN" "$CADDY_FILE"; then
  log "  ✓ bloc Caddy $DOMAIN déjà en place"
else
  log "Ajout du bloc reverse_proxy $DOMAIN → 127.0.0.1:3000 dans $CADDY_FILE"
  CADDY_BACKUP="${CADDY_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
  sudo cp "$CADDY_FILE" "$CADDY_BACKUP"
  log "  backup → $CADDY_BACKUP"

  sudo tee -a "$CADDY_FILE" >/dev/null <<CADDY

$DOMAIN {
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
    header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
}
CADDY

  if sudo caddy validate --config "$CADDY_FILE" >/tmp/caddy-validate.log 2>&1; then
    log '  ✓ caddy validate OK'
    sudo systemctl reload caddy
    if systemctl is-active --quiet caddy; then
      log '  ✓ caddy reload OK'
      log "  attente cert Let's Encrypt (jusqu'à 60s)…"
      CERT_OK=0
      for _ in 1 2 3 4 5 6; do
        sleep 10
        if sudo journalctl -u caddy --since "5 minutes ago" --no-pager 2>/dev/null \
             | grep -q "certificate obtained successfully.*$DOMAIN"; then
          log "  ✓ cert Let's Encrypt obtenu pour $DOMAIN"
          CERT_OK=1
          break
        fi
      done
      [ "$CERT_OK" -eq 1 ] || warn "  cert non confirmé dans le délai (vérif manuelle : journalctl -u caddy -n 80)"
    else
      warn "  caddy inactif après reload — rollback vers $CADDY_BACKUP"
      sudo cp "$CADDY_BACKUP" "$CADDY_FILE"
      sudo systemctl reload caddy || true
    fi
  else
    warn '  ✗ caddy validate KO — rollback automatique'
    sed -n '1,20p' /tmp/caddy-validate.log | sed 's/^/    /' >&2
    sudo cp "$CADDY_BACKUP" "$CADDY_FILE"
    fail "Caddyfile invalide après ajout du bloc $DOMAIN ; configuration restaurée."
  fi
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
