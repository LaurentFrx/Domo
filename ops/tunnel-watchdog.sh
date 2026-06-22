#!/bin/bash
# tunnel-watchdog — surveille les tunnels reverse SSH RPi4 -> VPS et libère
# automatiquement les ports tenus par un sshd "zombie" (demi-connexion morte),
# pour que les boucles ssh -R / le conteneur matter-tunnel du RPi4 réattachent.
#
# Cause traitée : un port reste LISTEN côté VPS alors que le lien vers le RPi est
# mort -> Domo n'a plus MQTT/Anker/clim/etc. (incident 2026-06-22, canicule).
# Voir mémoire vps_tazieff_tunnel_ghost_ports_powercut.
#
# Sécurités :
#  - n'agit QUE sur 127.0.0.1:<port tunnel> (jamais le sshd public :22) ;
#  - ne tue qu'un process dont le nom est exactement "sshd" ;
#  - exige FAIL_THRESHOLD échecs CONSÉCUTIFS avant de tuer (anti faux positif) ;
#  - DRY_RUN=1 -> journalise ce qu'il ferait sans rien tuer.

set -uo pipefail

FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"     # nb d'échecs consécutifs avant kill
TIMEOUT="${TIMEOUT:-4}"                    # timeout par sonde (s)
DRY_RUN="${DRY_RUN:-0}"
STATE_DIR=/run/tunnel-watchdog
mkdir -p "$STATE_DIR"

# Ports bridges HTTP (une absence TOTALE de réponse = code 000 = zombie)
HTTP_PORTS=(8095 8096 8097 8098 8099 8100 8101 8102)
MQTT_PORT=9001       # WebSocket -> 101 attendu
SSH_PORT=2222        # banner SSH attendu via le tunnel

log() { logger -t tunnel-watchdog "$*"; echo "$(date -Is) $*"; }

# pid du sshd qui tient le port LISTEN (vide si port absent)
listen_pid() {
  ss -tlnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
}

kill_zombie() {
  local port="$1" pid; pid="$(listen_pid "$port")"
  [[ -z "$pid" ]] && { log "port $port : plus de LISTEN, rien à tuer"; return; }
  local comm; comm="$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [[ "$comm" != "sshd" ]]; then
    log "port $port : pid $pid n'est pas un sshd ($comm) -> ABSTENTION"; return
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[DRY_RUN] port $port mort -> tuerait sshd $pid"
  else
    log "port $port mort -> kill -9 sshd $pid (libération pour réattache RPi)"
    kill -9 "$pid" 2>/dev/null
  fi
}

# enregistre le résultat d'une sonde ; déclenche kill au seuil
record() {
  local port="$1" ok="$2"; local f="$STATE_DIR/$port"
  if [[ "$ok" == "1" ]]; then
    [[ -f "$f" ]] && rm -f "$f"
    return
  fi
  local n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$f"
  log "port $port : sonde KO ($n/$FAIL_THRESHOLD)"
  if (( n >= FAIL_THRESHOLD )); then
    kill_zombie "$port"
    rm -f "$f"
  fi
}

probe_http() {
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "http://127.0.0.1:$1/" 2>/dev/null)"
  # 000 = aucune réponse TCP = tunnel mort. Tout code HTTP (200/404/…) = vivant.
  [[ "$code" == "000" ]] && echo 0 || echo 1
}

probe_mqtt() {
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZQ==' -H 'Sec-WebSocket-Protocol: mqtt' \
    "http://127.0.0.1:$1/" 2>/dev/null)"
  [[ "$code" == "000" ]] && echo 0 || echo 1
}

probe_ssh() {
  # le banner "SSH-2.0" vient du RPi via le tunnel ; absent = zombie
  local banner; banner="$(timeout "$TIMEOUT" bash -c "exec 3<>/dev/tcp/127.0.0.1/$1; head -c 8 <&3" 2>/dev/null)"
  [[ "$banner" == SSH-* ]] && echo 1 || echo 0
}

# --- boucle de surveillance : ne sonde QUE les ports actuellement en LISTEN ---
for p in "${HTTP_PORTS[@]}"; do
  [[ -z "$(listen_pid "$p")" ]] && { rm -f "$STATE_DIR/$p"; continue; }
  record "$p" "$(probe_http "$p")"
done

[[ -n "$(listen_pid "$MQTT_PORT")" ]] && record "$MQTT_PORT" "$(probe_mqtt "$MQTT_PORT")" || rm -f "$STATE_DIR/$MQTT_PORT"
[[ -n "$(listen_pid "$SSH_PORT")"  ]] && record "$SSH_PORT"  "$(probe_ssh  "$SSH_PORT")"  || rm -f "$STATE_DIR/$SSH_PORT"

exit 0
