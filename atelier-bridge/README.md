# atelier-bridge — l'aspirateur suit l'outil

Daemon 24/7 qui asservit l'**aspirateur de l'atelier** (prise Matter **node 29**)
à la consommation de la prise des **outils** (**node 28**) : l'outil démarre →
l'aspirateur part avec lui ; l'outil s'arrête → l'aspirateur s'arrête après un
délai de traînage (**5 s**, demandé par Laurent le 2026-07-31).

> **À déployer sur le RPi4**, à côté du matter-server — comme les autres bridges.
> Le code vit ici pour être versionné ; il **ne tourne pas** sur le VPS. Faire
> transiter l'asservissement par le tunnel SSH ajouterait un point de panne sur
> une boucle qui doit réagir en 2 secondes.

## La règle qui gouverne tout : on n'éteint QUE ce qu'on a allumé

Décision de Laurent. Si l'aspirateur est allumé **à la main** (pour balayer,
aspirer les copeaux par terre), le daemon n'y touche pas — il ne coupe jamais un
appareil qu'un humain a mis en marche.

| Situation                                           | Ce que fait le daemon                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Outil démarre, aspirateur éteint                    | l'allume, et en prend la **propriété**                                                           |
| Outil démarre, aspirateur **déjà allumé à la main** | ne fait rien, et n'en prend PAS la propriété → ne l'éteindra pas à la fin                        |
| Outil s'arrête, aspirateur à nous                   | l'éteint après `OFF_DELAY_S`                                                                     |
| Outil s'arrête, aspirateur allumé à la main         | **le laisse tourner**                                                                            |
| L'utilisateur éteint l'aspirateur en plein cycle    | lâche la propriété, et **ne le rallume pas** — l'asservissement reprend au cycle d'outil suivant |
| Le daemon redémarre en plein cycle                  | relit la propriété sur disque et rattrape l'extinction                                           |

Se battre avec la personne qui appuie sur le bouton est toujours le mauvais camp.

## Mesures réelles (essai du 2026-07-31 — ne pas régler au jugé)

| Grandeur                      | Mesure                                                         |
| ----------------------------- | -------------------------------------------------------------- |
| Outil à l'arrêt               | **0,0 W** (aucune veille)                                      |
| Outil en marche               | **103 à 195 W** (pic de 195 W au démarrage)                    |
| Aspirateur en marche          | **1 244 W**                                                    |
| Cadence de report de la prise | **~2 s** tant que la valeur bouge ; 15 s quand elle est stable |

Les seuils `ON_W=20` / `OFF_W=10` sont donc à un ordre de grandeur du bruit
comme du signal. Ils ne sont pas un « chiffre rond au doigt mouillé » : ils
viennent de cette capture.

### Ce que ça donne en temps réel

- **Démarrage** : l'aspirateur part **~2 s après** l'outil.
- **Arrêt** : la prise peut mettre jusqu'à **~4 s** à annoncer le passage à 0 W
  (mesuré : 4,1 s sur l'essai). Extinction réelle = ce délai + `OFF_DELAY_S`,
  soit **5 à 9 s** après l'arrêt de l'outil. Le « 5 s » demandé est le délai
  _ajouté_, pas le total — la prise ne sait pas faire mieux.

## Installation (RPi4)

```bash
cd ~/atelier-bridge
docker build -t atelier-bridge:latest .
docker run -d --name atelier-bridge --restart unless-stopped --network host \
  -v /home/laurent/docker/atelier-bridge/data:/data \
  --env-file .env atelier-bridge:latest
```

Journal : `docker logs -f atelier-bridge`.

## Configuration (.env)

| Variable         | Défaut                     | Rôle                                      |
| ---------------- | -------------------------- | ----------------------------------------- |
| `MATTER_WS_URL`  | `ws://127.0.0.1:5580/ws`   | python-matter-server (réseau `host`)      |
| `TOOL_NODE_ID`   | `28`                       | prise « Outils atelier »                  |
| `VACUUM_NODE_ID` | `29`                       | prise « Aspirateur »                      |
| `ON_W` / `OFF_W` | `20` / `10`                | hystérésis de détection (W)               |
| `OFF_DELAY_S`    | `5`                        | traînage après l'arrêt de l'outil         |
| `OBSERVE_ONLY`   | `0`                        | `1` = journalise sans commander le relais |
| `STATE_PATH`     | `/data/atelier_state.json` | propriété persistée                       |

⚠️ **Le volume `/data` n'est pas décoratif** : sans lui, un redémarrage du
conteneur en plein cycle perd la propriété de l'aspirateur, et plus personne
n'est là pour l'éteindre.

## Pièges

- **Ne pas repasser par `get_nodes` à chaque événement** (ce que fait
  `thermostat_bridge.py`) : l'aller-retour supplémentaire coûterait la moitié du
  budget de réaction. On lit la valeur directement dans `attribute_updated`.
- **L'écho de nos propres commandes** : après un `On`/`Off` envoyé, la prise
  rapporte le changement d'état. Sans la fenêtre `ECHO_WINDOW_S`, le daemon
  prendrait sa propre commande pour une intervention humaine et lâcherait la
  propriété aussitôt après l'avoir prise.
- **Éteindre la prise de l'outil** (node 28) met sa puissance à 0 W : l'outil est
  donc vu « arrêté », et l'aspirateur suit. C'est voulu.
