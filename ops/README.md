# ops/ — exploitation du VPS

## tunnel-watchdog

Surveille les **tunnels reverse SSH RPi4 → VPS** et libère automatiquement un port
tenu par un `sshd` « zombie » (demi-connexion gelée : le tunnel paraît ouvert mais
le forward ne répond plus). Sans lui, Domo peut se retrouver **sans aucune liaison
domotique** (MQTT, Anker, clim, capteurs) jusqu'à intervention manuelle — c'est
l'incident du 2026-06-22 (perte de pilotage clim en pleine canicule).

### Pourquoi le keepalive sshd ne suffit pas

Le drop-in `/etc/ssh/sshd_config.d/10-tunnel-keepalive.conf` (`ClientAliveInterval 30`)
ferme une connexion dont le **canal de contrôle** SSH est mort. Mais lors de l'incident,
le canal de contrôle restait vivant (le RPi répondait aux keepalives) tandis que le
**canal de forwarding** était gelé → sshd ne fermait rien. Le watchdog teste le
**forward réel** (le tunnel répond-il vraiment ?), ce que le keepalive ne fait pas.

### Fonctionnement

`tunnel-watchdog.sh` sonde, toutes les 60 s, chaque port tunnel **en écoute** :

- bridges HTTP `8095-8102` → `curl` (`000` = mort)
- MQTT WebSocket `9001` → upgrade WS (`101` attendu)
- SSH RPi `2222` → bannière `SSH-2.0`

Après `FAIL_THRESHOLD=3` échecs **consécutifs** (anti faux positif), il tue le `sshd`
qui tient le port LISTEN. Les boucles `ssh -R` et le conteneur `matter-tunnel` du RPi
(`restart: unless-stopped`) réattachent alors le port en ~10 s.

Garde-fous : n'agit que sur `127.0.0.1:<port tunnel>` (jamais le sshd public `:22`),
ne tue qu'un process nommé exactement `sshd`, `DRY_RUN=1` journalise sans tuer,
compteurs d'échec dans `/run/tunnel-watchdog/`.

### Installation (VPS, root)

```sh
sudo cp ops/tunnel-watchdog.sh /usr/local/bin/tunnel-watchdog.sh
sudo chmod 755 /usr/local/bin/tunnel-watchdog.sh
sudo cp ops/tunnel-watchdog.service /etc/systemd/system/
sudo cp ops/tunnel-watchdog.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tunnel-watchdog.timer
```

La copie active vit dans `/usr/local/bin` (hors dépôt, à l'abri d'un `git clean`).
Après modification du script ici, recopier vers `/usr/local/bin` pour activer.

### Diagnostic / réglage

```sh
# voir les interventions
journalctl -t tunnel-watchdog -n 50
# test à blanc (ne tue rien)
sudo DRY_RUN=1 FAIL_THRESHOLD=1 /usr/local/bin/tunnel-watchdog.sh
```

Cadence réglable : `FAIL_THRESHOLD` (script) et `OnUnitActiveSec` (timer).
