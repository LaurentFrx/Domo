# Tunnel SSH inverse RPi4 → VPS pour python-matter-server

## Pourquoi

La PWA Domo est servie en `https://domo.feroux.fr`. Pour piloter les volets
Matter, elle a besoin d'une connexion WebSocket vers le `python-matter-server`
qui tourne sur le RPi4 (`ws://192.168.1.29:5580/ws`).

Safari iOS (et Chrome moderne) bloquent les WebSockets non-sécurisés depuis
une page HTTPS (« mixed content »). Solution : exposer le matter-server via
le VPS public en WSS (`wss://domo.feroux.fr/matter/ws`), grâce à un tunnel
SSH inverse RPi4 → VPS.

```
Client iOS  ─ wss://domo.feroux.fr/matter/ws ─►  Caddy (VPS)
                                                   │
                                                   ▼  127.0.0.1:5580
                                                tunnel SSH inverse
                                                   ▲
                                                   │
                                            python-matter-server (RPi4)
```

## Installation sur le RPi4

### 1. Générer une clé SSH dédiée au tunnel

```bash
ssh-keygen -t ed25519 -f ~/.ssh/matter_tunnel_ed25519 -N "" \
    -C "matter-tunnel rpi4->vps"
```

### 2. Autoriser cette clé côté VPS

Sur le **VPS** (en tant que `laurent`), ajouter la pubkey à `~/.ssh/authorized_keys`
en restreignant fortement ce qu'elle peut faire :

```bash
# Sur le VPS — copier-coller la sortie de `cat ~/.ssh/matter_tunnel_ed25519.pub`
# depuis le RPi4, puis :
echo 'no-pty,no-X11-forwarding,no-agent-forwarding,no-user-rc,permitopen="127.0.0.1:5580",command="echo tunnel-only" ssh-ed25519 AAAA...XYZ matter-tunnel rpi4->vps' \
    >> ~/.ssh/authorized_keys
```

Cette ligne :

- bloque toute commande interactive (`command="echo tunnel-only"`)
- autorise uniquement le forward vers `127.0.0.1:5580` (`permitopen=...`)
- désactive PTY, X11, agent forwarding, ~/.ssh/rc

### 3. Installer le service systemd

Copier le fichier `matter-tunnel.service` sur le RPi4 :

```bash
# Adapter l'utilisateur (User=pi) si besoin dans le .service
sudo cp matter-tunnel.service /etc/systemd/system/matter-tunnel.service
sudo systemctl daemon-reload
sudo systemctl enable --now matter-tunnel.service
sudo systemctl status matter-tunnel.service
```

### 4. Tester depuis le VPS

```bash
# Sur le VPS, vérifier que le port est bien ouvert
ss -tln | grep 5580
# tcp   LISTEN 0  128  127.0.0.1:5580  0.0.0.0:*

# Vérifier que le proxy Caddy WSS répond
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
    -H "Upgrade: websocket" -H "Connection: Upgrade" \
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
    -H "Sec-WebSocket-Version: 13" \
    https://domo.feroux.fr/matter/ws
# HTTP 101  (Switching Protocols — handshake WS OK)
```

### 5. Vérifier depuis l'iPhone

Ouvrir `https://domo.feroux.fr/pieces` — le bandeau « Matter » doit passer
en « Connecté » et les volets en ligne doivent afficher leur position réelle.

## Diagnostic

```bash
# Logs du tunnel
journalctl -u matter-tunnel -f

# Tunnel actif ?
sudo systemctl status matter-tunnel

# Port côté VPS
ssh laurent@domo.feroux.fr 'ss -tln | grep 5580'
```

## Sécurité

- La clé `matter_tunnel_ed25519` ne sert qu'au tunnel, ne donne aucun shell.
- `permitopen` bloque tout forward autre que `127.0.0.1:5580`.
- Le matter-server n'est jamais exposé publiquement : Caddy est en frontal,
  HTTPS obligatoire, et le port 5580 sur le VPS est en loopback uniquement.
- Pour une authentification supplémentaire au niveau du WS, voir la conf
  de `python-matter-server` (paramètre `--listen-address` et `--api-key`).
