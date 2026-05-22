#!/usr/bin/env bash
#
# bootstrap-vps.sh — Provision Domo sur le VPS Hetzner.
#
# Idempotent : peut être relancé sans casser un déploiement existant.
# Détecte un Caddy déjà installé (container ou systemd) pour cohabiter
# avec d'autres projets (ex. tazieff-eps).
#
# Usage : bash scripts/bootstrap-vps.sh
#         curl -fsSL https://raw.githubusercontent.com/LaurentFrx/Domo/main/scripts/bootstrap-vps.sh | bash

set -euo pipefail

REPO_URL="https://github.com/LaurentFrx/Domo.git"
TARGET_DIR="/home/laurent/domo"
DOMAIN="domo.feroux.fr"

log()  { printf '\033[1;34m[domo]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[domo]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[domo]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Prérequis ─────────────────────────────────────────────────
log 'Vérification Docker + docker compose v2…'
command -v docker >/dev/null 2>&1 || fail 'Docker introuvable. Installer Docker avant de relancer ce script.'
docker compose version >/dev/null 2>&1 || fail 'docker compose v2 introuvable. Installer le plugin compose avant de relancer.'
log "  Docker $(docker --version | awk '{print $3}' | tr -d ,) — compose $(docker compose version --short)"

# ── 2. Clone ou pull du repo ─────────────────────────────────────
if [ -d "$TARGET_DIR/.git" ]; then
  log "Repo déjà cloné dans $TARGET_DIR — git pull"
  git -C "$TARGET_DIR" pull --ff-only origin main
else
  log "Clone $REPO_URL → $TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

# ── 3. Détection du Caddy partagé ────────────────────────────────
CADDY_MODE='none'
if docker ps --format '{{.Names}}' | grep -qE '(^|[^-])caddy([^-]|$)|caddy$'; then
  # Un container avec "caddy" dans le nom tourne (hors domo-caddy)
  RUNNING_CADDY=$(docker ps --format '{{.Names}}' | grep -i caddy | grep -v '^domo-caddy$' | head -1 || true)
  if [ -n "$RUNNING_CADDY" ]; then
    CADDY_MODE='shared-container'
    log "Caddy partagé détecté : container '$RUNNING_CADDY'"
  fi
fi
if [ "$CADDY_MODE" = 'none' ] && systemctl is-active --quiet caddy 2>/dev/null; then
  CADDY_MODE='systemd'
  log 'Caddy partagé détecté : service systemd'
fi
if [ "$CADDY_MODE" = 'none' ]; then
  log 'Aucun Caddy détecté — démarrage du stack complet (PWA + Caddy embarqué)'
fi

# ── 4. Démarrage ─────────────────────────────────────────────────
case "$CADDY_MODE" in
  shared-container)
    warn ''
    warn '┌─ ACTION MANUELLE REQUISE ──────────────────────────────────────'
    warn "│  Un Caddy partagé tourne déjà ('$RUNNING_CADDY')."
    warn '│  Ajouter ce bloc au Caddyfile partagé puis recharger Caddy :'
    warn '│'
    warn "│    $DOMAIN {"
    warn '│        encode gzip zstd'
    warn '│        reverse_proxy domo:3000'
    warn '│        header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"'
    warn '│    }'
    warn '│'
    warn "│  Le container 'domo' doit être sur le même réseau Docker que"
    warn "│  '$RUNNING_CADDY'. Vérifier avec :"
    warn "│    docker network inspect <reseau> | grep -E 'domo|$RUNNING_CADDY'"
    warn '└────────────────────────────────────────────────────────────────'
    warn ''
    log 'Démarrage du container domo seul (sans caddy embarqué)…'
    docker compose up -d --build domo
    ;;
  systemd)
    warn ''
    warn '┌─ ACTION MANUELLE REQUISE ──────────────────────────────────────'
    warn '│  Caddy tourne en systemd. Ajouter ce bloc à /etc/caddy/Caddyfile'
    warn '│  puis : sudo systemctl reload caddy'
    warn '│'
    warn "│    $DOMAIN {"
    warn '│        encode gzip zstd'
    warn '│        reverse_proxy 127.0.0.1:3000'
    warn '│        header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"'
    warn '│    }'
    warn '│'
    warn '│  NOTE : le container expose 3000 en interne uniquement. Pour'
    warn '│  laisser Caddy systemd y accéder, ajouter au service domo dans'
    warn '│  docker-compose.yml :'
    warn '│    ports:'
    warn "│      - '127.0.0.1:3000:3000'"
    warn '└────────────────────────────────────────────────────────────────'
    warn ''
    log 'Démarrage du container domo seul (sans caddy embarqué)…'
    docker compose up -d --build domo
    ;;
  none)
    log 'Démarrage de docker compose up -d --build (PWA + Caddy)…'
    docker compose up -d --build
    ;;
esac

# ── 5. Vérification finale ───────────────────────────────────────
log ''
log "Test HTTPS sur https://$DOMAIN …"
sleep 3
if curl -sI --max-time 10 "https://$DOMAIN" >/dev/null 2>&1; then
  log "  ✓ https://$DOMAIN répond"
  curl -sI "https://$DOMAIN" | head -5 | sed 's/^/    /'
else
  warn "  ✗ https://$DOMAIN injoignable pour l'instant."
  warn '    Causes possibles :'
  warn "    - DNS pas encore propagé ($DOMAIN → IP du VPS)"
  warn "    - Let's Encrypt en cours de provisioning (attendre ~30s)"
  warn "    - Bloc Caddy manuel pas encore ajouté (cf. instructions ci-dessus)"
  warn "    Diagnostic : docker logs domo  &&  docker logs <caddy-container>"
fi

log ''
log 'Bootstrap terminé.'
