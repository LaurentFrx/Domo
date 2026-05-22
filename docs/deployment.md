# Déploiement Hetzner

## Prérequis VPS

- Ubuntu 22.04+ ou Debian 12+
- Docker + Docker Compose v2 installés
- Ports 80 et 443 ouverts dans le firewall
- DNS A/AAAA pour `domo.feroux.fr` pointant vers l'IP du VPS

## Première installation

Le script `scripts/bootstrap-vps.sh` s'occupe de tout :

```bash
ssh laurent@<vps>
curl -fsSL https://raw.githubusercontent.com/LaurentFrx/Domo/main/scripts/bootstrap-vps.sh | bash
```

Ou manuellement :

```bash
cd /home/laurent
git clone https://github.com/LaurentFrx/Domo.git domo
cd domo
docker compose up -d --build
```

Caddy détecte le domaine, demande un certificat Let's Encrypt
automatiquement. ~30 secondes pour HTTPS actif.

## Mises à jour

Auto-deploy via GitHub Actions à chaque push sur `main`
(voir `.github/workflows/deploy.yml`).

Manuel si besoin :

```bash
cd /home/laurent/domo
git pull
docker compose up -d --build domo
```

## Cohabitation avec d'autres projets

Si un Caddy partagé tourne déjà sur le VPS (ex. projet `tazieff-eps`),
ne PAS démarrer le service `caddy` de ce compose. Ajouter à la place
le bloc `domo.feroux.fr` dans le Caddyfile partagé :

```caddy
domo.feroux.fr {
    encode gzip zstd
    reverse_proxy domo:3000
    header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
}
```

Puis :

```bash
docker compose up -d --build domo   # PWA seulement, sans caddy embarqué
```

## Logs

```bash
# Logs containers
docker compose logs -f

# Logs Caddy (HTTPS, requêtes)
docker logs domo-caddy
```

## Sauvegarde

Le seul état persistant est dans le volume `caddy_data`
(certificats Let's Encrypt). À sauvegarder régulièrement :

```bash
docker run --rm -v domo_caddy_data:/data \
  -v $(pwd):/backup alpine \
  tar czf /backup/caddy-data-$(date +%Y%m%d).tar.gz /data
```
