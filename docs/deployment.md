# Déploiement Hetzner

Déploiement bare-metal (pas de Docker) : SvelteKit adapter-node +
systemd + Caddy systemd partagé. Fait pour cohabiter avec d'autres
projets sur le même VPS.

## Prérequis VPS

- Ubuntu 22.04+ ou Debian 12+
- Caddy en service systemd, écoute sur 80/443
- `laurent` peut sudo (mot de passe accepté pour le bootstrap initial)
- DNS A/AAAA pour `domo.feroux.fr` pointant vers l'IP du VPS

`bootstrap-vps.sh` se charge automatiquement de :

- Installer Node LTS (via NodeSource) si absent ou trop ancien
- Installer pnpm en global (via `npm install -g pnpm`)
- Créer `/etc/sudoers.d/domo-deploy` pour autoriser laurent à exécuter
  `systemctl restart domo` et `systemctl reload caddy` sans password
  (utilisé ensuite par le workflow GitHub Actions)

## Première installation

Le script `scripts/bootstrap-vps.sh` est idempotent :

```bash
ssh laurent@<vps>
bash <(curl -fsSL https://raw.githubusercontent.com/LaurentFrx/Domo/main/scripts/bootstrap-vps.sh)
```

Il :

1. Vérifie Node / pnpm / Caddy systemd
2. Clone (ou pull) le repo dans `/home/laurent/domo`
3. `pnpm install --frozen-lockfile && pnpm build`
4. Installe `deploy/domo.service` dans `/etc/systemd/system/`
5. `systemctl enable --now domo`
6. Imprime le bloc Caddyfile à ajouter manuellement à `/etc/caddy/Caddyfile`
7. Teste HTTPS

## Caddyfile partagé

À ajouter dans `/etc/caddy/Caddyfile` (à côté des autres sites) :

```caddy
domo.feroux.fr {
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
    header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
}
```

Puis :

```bash
sudo systemctl reload caddy
```

## Variables d'environnement

`/home/laurent/domo/.env` (gitignored) :

```env
SOLCAST_API_KEY=...
SOLCAST_RESOURCE_ID=...
```

Le service systemd charge ce fichier via `EnvironmentFile=`. Après
modification :

```bash
sudo systemctl restart domo
```

## Mises à jour

Auto-deploy via GitHub Actions à chaque push sur `main`
(voir `.github/workflows/deploy.yml`).

Manuel si besoin :

```bash
cd /home/laurent/domo
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart domo
```

## Logs

```bash
# Service domo
journalctl -u domo -f
journalctl -u domo -n 50 --no-pager

# Caddy
journalctl -u caddy -f
```

## Diagnostic

```bash
systemctl status domo
curl -sI http://127.0.0.1:3000/
curl -sI https://domo.feroux.fr
```
