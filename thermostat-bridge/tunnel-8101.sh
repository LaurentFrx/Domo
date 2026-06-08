#!/usr/bin/env bash
# Tunnel SSH inverse : expose le thermostat-bridge (RPi4 loopback :8101) sur le
# VPS loopback :8101, lu par Domo (THERMOSTAT_BRIDGE_URL=http://127.0.0.1:8101).
# À lancer depuis le RPi4 (crontab @reboot), même modèle que tunnel-8100.sh.
set -euo pipefail
VPS="${VPS_HOST:-laurent@tazieff-dev}"
while true; do
  ssh -NT \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -R 127.0.0.1:8101:127.0.0.1:8101 \
    "$VPS" || true
  sleep 5
done
