#!/usr/bin/env bash
#
# fix-caddy-domo-once.sh — Script d'urgence one-shot.
#
# Ajoute le bloc reverse_proxy `domo.feroux.fr` au Caddyfile du VPS
# tazieff-dev, valide, reload, attend le cert Let's Encrypt, puis
# vérifie que https://domo.feroux.fr répond.
#
# À coller dans un Git Bash local ayant un alias SSH `tazieff-dev`.
# Laurent a sudoers NOPASSWD sur le VPS — pas de prompt mot de passe.
#
# Idempotent : si le bloc est déjà présent, saute backup/append/validate
# et passe direct au reload + vérif cert + curl final.
#
# À supprimer du repo après le premier run réussi de bootstrap-vps.sh
# en version "Caddy géré automatiquement".

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────
REMOTE='tazieff-dev'
DOMAIN='domo.feroux.fr'
CADDY_FILE='/etc/caddy/Caddyfile'
SERVICE_NAME='domo'
APP_PORT=3000

# ── Helpers couleur ──────────────────────────────────────────────
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { printf '\033[36m==> %s\033[0m\n' "$*"; }

# Wrapper SSH unique — facilite la lecture et le mock éventuel.
remote() { ssh "$REMOTE" "$@"; }

# ── 1. Diagnostic ────────────────────────────────────────────────
step "Diagnostic état actuel sur $REMOTE"

if remote "systemctl is-active --quiet $SERVICE_NAME"; then
  green "  ok $SERVICE_NAME actif"
else
  red   "  ko $SERVICE_NAME inactif — Caddy ne servirait que du 502."
  red   "      ssh $REMOTE 'sudo journalctl -u $SERVICE_NAME -n 50 --no-pager'"
  exit 1
fi

if remote "ss -tlnp 2>/dev/null | grep -q ':$APP_PORT '"; then
  green "  ok un process écoute sur :$APP_PORT"
else
  red   "  ko personne n'écoute sur :$APP_PORT — reverse-proxy dans le vide."
  exit 1
fi

if remote "curl -sI --max-time 5 http://127.0.0.1:$APP_PORT >/dev/null 2>&1"; then
  green "  ok 127.0.0.1:$APP_PORT répond en HTTP"
else
  yellow "  warn 127.0.0.1:$APP_PORT n'a pas répondu à curl (peut-être 404 sur /), on continue."
fi

# Détection du bloc — short-circuit si déjà installé.
CADDY_HAS_BLOCK=0
if remote "sudo grep -qE '^${DOMAIN}[[:space:]]*\\{' $CADDY_FILE 2>/dev/null"; then
  CADDY_HAS_BLOCK=1
  yellow "  warn bloc $DOMAIN déjà présent dans $CADDY_FILE — saut direct au reload + vérif"
else
  green "  ok aucun bloc $DOMAIN dans $CADDY_FILE, on l'ajoute"
fi

# ── 2-5. Backup + ajout + validate + reload (si absent) ──────────
BACKUP_PATH=''
if [ "$CADDY_HAS_BLOCK" -eq 0 ]; then
  step "Backup horodaté de $CADDY_FILE"
  # La date est calculée côté VPS pour rester cohérente avec son horloge.
  BACKUP_PATH=$(remote "BAK=$CADDY_FILE.bak.\$(date +%Y%m%d-%H%M%S); sudo cp $CADDY_FILE \"\$BAK\" && echo \"\$BAK\"")
  green "  ok backup → $BACKUP_PATH"

  step "Ajout du bloc reverse_proxy"
  # Heredoc quoté : aucune expansion locale, le contenu part tel quel.
  remote "sudo tee -a $CADDY_FILE >/dev/null" <<'CADDY'

domo.feroux.fr {
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
    header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
}
CADDY
  green "  ok bloc ajouté"

  step "Validation syntaxe Caddyfile"
  if remote "sudo caddy validate --config $CADDY_FILE" >/dev/null 2>&1; then
    green "  ok caddy validate OK"
  else
    red "  ko caddy validate a échoué — rollback automatique depuis $BACKUP_PATH"
    remote "sudo cp \"$BACKUP_PATH\" $CADDY_FILE"
    red "      Caddyfile restauré. Sortie caddy validate :"
    remote "sudo caddy validate --config $CADDY_FILE" || true
    exit 1
  fi

  step "Reload Caddy"
  remote "sudo systemctl reload caddy"
  if remote "systemctl is-active --quiet caddy"; then
    green "  ok caddy actif après reload"
  else
    red "  ko caddy n'est plus actif — rollback + reload de la version backup"
    remote "sudo cp \"$BACKUP_PATH\" $CADDY_FILE && sudo systemctl reload caddy"
    exit 1
  fi
else
  step "Reload Caddy (par sécurité, même si bloc déjà présent)"
  remote "sudo systemctl reload caddy"
  green "  ok reload OK"
fi

# ── 6. Attente du certificat Let's Encrypt ───────────────────────
step "Attente du certificat Let's Encrypt pour $DOMAIN (max 60s)"
CERT_OK=0
for i in 1 2 3 4 5 6; do
  sleep 10
  # Caddy logge "certificate obtained successfully" + le nom de domaine.
  if remote "sudo journalctl -u caddy -n 300 --no-pager 2>/dev/null | grep -iE 'certificate obtained|obtained certificate|served' | grep -q $DOMAIN"; then
    CERT_OK=1
    green "  ok cert mentionné dans les logs (après ${i}0s)"
    break
  fi
  printf '  … attente (%ds)\n' "$((i * 10))"
done

if [ "$CERT_OK" -eq 0 ]; then
  yellow ""
  yellow "  warn aucune mention 'certificate obtained' pour $DOMAIN dans les 60s."
  yellow "       Le bloc reste en place — à investiguer si curl échoue :"
  yellow "         ssh $REMOTE 'sudo journalctl -u caddy -n 100 --no-pager'"
  yellow ""
fi

# ── 7. Test final HTTPS ──────────────────────────────────────────
step "Test final : curl -sI https://$DOMAIN"
HTTP_LINE=$(curl -sI --max-time 10 "https://$DOMAIN" 2>/dev/null | head -1 || true)
HTTP_STATUS=$(printf '%s' "$HTTP_LINE" | awk '{print $2}')

printf '  réponse : %s\n' "${HTTP_LINE:-<aucune>}"

if [ "${HTTP_STATUS:-}" = "200" ]; then
  green ""
  green "  ✓ HTTP $HTTP_STATUS — https://$DOMAIN est live"
  green "  → ouvre https://$DOMAIN dans le navigateur"
  green ""
else
  red ""
  red "  ✗ status inattendu : ${HTTP_STATUS:-<aucune réponse>}"
  red "    debug : curl -vI https://$DOMAIN"
  red "            ssh $REMOTE 'sudo journalctl -u caddy -n 100 --no-pager'"
  red ""
fi
