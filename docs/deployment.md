# Déploiement Hetzner

## Prérequis VPS

- Ubuntu 22.04+ ou Debian 12+
- Docker + Docker Compose v2 installés
- Ports 80 et 443 ouverts dans le firewall
- DNS A/AAAA pour `dashboard.feroux.fr` pointant vers l'IP du VPS

## Première installation

```bash
# Sur le VPS
cd /opt
git clone https://github.com/LaurentFrx/ha-pwa.git
cd ha-pwa

# Build et lancement
docker compose up -d --build

# Vérifier
docker compose logs -f ha-pwa
docker compose logs -f caddy
```

Caddy détecte le domaine, demande un certificat Let's Encrypt
automatiquement. ~30 secondes pour HTTPS actif.

## Mises à jour

```bash
cd /opt/ha-pwa
git pull
docker compose up -d --build
```

## Mutualisation avec HA-Push-Relay

Quand le push relay sera déployé, ajouter dans `docker-compose.yml` :

```yaml
  ha-push-relay:
    image: ghcr.io/laurentfrx/ha-push-relay:latest
    container_name: ha-push-relay
    restart: unless-stopped
    networks:
      - web
    expose:
      - "8080"
```

Et dans `Caddyfile` :

```caddy
push.feroux.fr {
    reverse_proxy ha-push-relay:8080
    encode gzip
}
```

## Logs

```bash
# Logs containers
docker compose logs -f

# Logs Caddy (HTTPS, requêtes)
docker exec ha-caddy cat /var/log/caddy/dashboard.log
```

## Sauvegarde

Le seul état persistant est dans le volume `caddy_data`
(certificats Let's Encrypt). À sauvegarder régulièrement :

```bash
docker run --rm -v ha-pwa_caddy_data:/data \
  -v $(pwd):/backup alpine \
  tar czf /backup/caddy-data-$(date +%Y%m%d).tar.gz /data
```
