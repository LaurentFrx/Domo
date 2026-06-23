# Fiabilité Domo — couche de robustesse, détection & auto-réparation

Mise en place le 2026-06-23 en réponse aux audits (`audit-fiabilite-2026-06-23.md`,
`audit-fiabilite-synthese-2026-06-23.md`). Objectif : **aucune perte de données
silencieuse, aucune défaillance non détectée, et une réparation automatique sans
intervention.** Ce document décrit ce qui a été ajouté et comment l'exploiter.

> Principe directeur : on **impose** (écritures durables), on **réconcilie** (les
> trous de données se comblent seuls via les compteurs cumulés), et on
> **surveille** (sondes + alerte immédiate). Le bon modèle défensif déjà présent
> dans le moteur cumulus a été généralisé au reste de l'app.

---

## 1. Persistence indestructible — `src/lib/server/atomic-store.ts`

Toutes les écritures d'état (`settings.json`, `planning.json`, `cumulus-state.json`)
passent par `writeJsonAtomic()` :

```
write(tmp) → fsync(tmp) → copie .bak (version N-1) → rename atomique → fsync(dir)
```

Le `fsync` est la pièce qui manquait : sans lui, un `rename` peut survivre à une
coupure de courant alors que les blocs du fichier sont encore dans le cache → fichier
vide au reboot (R1). La copie `.bak` donne un filet (R4).

La lecture, `readJsonSafe()`, distingue :

- **fichier absent** (`ENOENT`) → valeur par défaut (légitime, silencieux) ;
- **fichier corrompu** → mise en **quarantaine** (`.corrupt-<ts>`) + **restauration
  automatique depuis `.bak`** + **incident critique** (R2). Jamais un défaut muet
  qui écraserait ensuite la vraie donnée.

`tariffs.json` (lu en synchrone, édité à la main) : une corruption ne retombe plus
silencieusement sur le tarif par défaut — elle lève un **incident critique** (R3).

Couvre : **R1, R2, R3, R4, R25**.

---

## 2. Bus d'incidents — `src/lib/server/monitor/incidents.ts`

Source unique de vérité de « qu'est-ce qui ne va pas en ce moment ». En mémoire
(partagée dans le process) + persistance `data/incidents.json`. Idempotent par
clé (`source:kind`). Une anomalie qui revient à la normale est **résolue**.

Lu par `/api/health` (bandeau + page Réglages) et par le moniteur (alertes + audit).

---

## 3. Sondes de santé — `src/lib/server/monitor/probes.ts`

S'appuient sur `history.db` (sortie du recorder) comme **source persistante**,
plutôt que des fetchs réseau en plus. Détectent :

| Anomalie            | Gravité  | Critère                                                                 |
| ------------------- | -------- | ----------------------------------------------------------------------- |
| `recorder:stalled`  | critique | aucune mesure depuis > 4 min (recorder figé)                            |
| `apsystems:blind`   | critique | en plein jour, APS jamais éveillé + compteur figé sur 15 min (le 23/06) |
| `em50:down`         | warning  | aucune mesure EM-50 non-nulle sur 10 min                                |
| `anker:down`        | warning  | Anker indisponible sur 10 min                                           |
| `mqtt:down`         | warning  | hub MQTT serveur déconnecté                                             |
| `corrupt:<fichier>` | critique | levé par `atomic-store`/`tariffs` en cas de corruption                  |

Si le recorder est figé, les autres sondes énergie sont court-circuitées (sinon
faux positifs). La nuit, l'APS endormi n'est pas une anomalie.

Couvre : **R5, R6, R9 (volet serveur), C3, M5**.

---

## 4. Auto-réparation — `src/lib/server/monitor/repair.ts` + recorder

Sans feu vert (mandat explicite), strictement bornée :

- **Recorder figé** → `sudo -n systemctl restart domo-recorder.timer` (liste
  blanche, args fixes, anti-rebond 15 min).
- **Fichier corrompu** → restauration automatique depuis `.bak` (cf. §1).
- **Trou de données APS** → **réconciliation automatique** dans `record.py`
  (`reconcile_aps`). Quand l'onduleur revient après une cécité du bridge, l'énergie
  manquée est récupérée depuis le **compteur cumulé `lifetime`** (monotone, survit à
  la panne), la part auto-consommée est calculée (`manquée − exportée`) et **répartie
  au prorata de la production SolarBank** (même soleil) pour tomber sur le bon jour
  et le bon tarif HP/HC. Idempotent (`reconciliation_log`), borné (`MAX_RECON_KWH`),
  isolé, **auditable et réversible** (table `reconciliation_log` dans `history.db`).

C'est le correctif de fond de l'incident du 23/06 : un tel trou se comblerait
désormais **tout seul** au retour de l'onduleur.

Couvre : **C2/R7 (fond), R16 (partiel), C1 (mitigation par alerte)**.

---

## 5. Alerte immédiate

### Bandeau in-app — `HealthBanner.svelte` + `health.svelte.ts`

`/api/health` renvoie désormais `{ mqtt, incidents }`. Le bandeau affiche, sous le
bandeau « Liaison interrompue » existant (inchangé), une ligne par anomalie active
(rouge = critique, ambre = warning), avec la mention de l'auto-réparation appliquée.

### Web Push — app fermée (`src/lib/server/monitor/push.ts`, `push-client.ts`, `static/push-sw.js`)

Canal d'alerte qui fonctionne même app fermée (PWA iOS installée). VAPID, abonnement
opt-in depuis **Réglages → Notifications d'anomalie** (bouton + bouton « Tester »).
Politique anti-spam : critiques poussés immédiatement, warnings seulement s'ils
persistent 5 min ; **notification de rétablissement** quand l'anomalie disparaît.

Le handler push est greffé sur le service worker vite-pwa via `workbox.importScripts`
(**additif** — ne change pas la stratégie de cache offline).

Couvre : **R5, R10 (surfaçage), R13 (handleError ajouté)**.

> iOS : nécessite la PWA installée sur l'écran d'accueil + autorisation des
> notifications (geste utilisateur via le bouton Réglages). Sans abonné, le bandeau
> in-app reste le canal de secours.

---

## 6. Le cycle complet — `/api/monitor/tick`

Endpoint déclenché toutes les 60 s par `domo-monitor.timer` (auth Bearer
`MONITOR_TOKEN`, bypass cookie en match exact) :

```
sonder toutes les sources → auto-réparer ce qui peut l'être → pousser les nouvelles
anomalies → notifier les rétablissements
```

Tout tourne dans le process de l'app, donc partage le bus d'incidents avec
`/api/health` (réponse instantanée côté client, sans appel réseau).

---

## 7. Sauvegardes — `ops/backup-domo.sh` + `domo-backup.timer`

Quotidienne (03:30) : `data/*.json` + `history.db` (**snapshot SQLite cohérent** via
l'API `.backup`, jamais un `cp` à chaud), copie horodatée dans
`/home/laurent/backups/domo/<STAMP>/`, rotation 14 jours. Couvre **R4/V4**.

**Restauration** : un dossier = un instantané complet autoportant.

```bash
# service Domo arrêté pendant la restauration
sudo systemctl stop domo
cp /home/laurent/backups/domo/<STAMP>/{settings,planning,cumulus-state,tariffs}.json /home/laurent/domo/data/
gunzip -c /home/laurent/backups/domo/<STAMP>/history.db.gz > /home/laurent/domo-recorder/history.db
sudo systemctl start domo
```

---

## 8. Exploitation

### Variables d'environnement (`.env`, non commité — voir `.env.example`)

- `MONITOR_TOKEN` — auth du timer moniteur.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — Web Push.

### Units systemd (NON gérées par le CI/CD — installation manuelle)

```bash
sudo cp deploy/domo-monitor.service deploy/domo-monitor.timer \
        deploy/domo-backup.service  deploy/domo-backup.timer  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now domo-monitor.timer domo-backup.timer
```

### Vérifier

```bash
journalctl -u domo-monitor -f                      # cycles du moniteur
curl -fsS -X POST -H "Authorization: Bearer $MONITOR_TOKEN" \
     http://127.0.0.1:3000/api/monitor/tick         # un cycle à la main
systemctl list-timers domo-monitor domo-backup      # planification
```

### Tester l'alerte de bout en bout

Réglages → activer les notifications → « Tester » (push de test), ou simuler une
anomalie (couper un tunnel) et observer le bandeau + le push après le délai.

---

## 9. Durcissements complémentaires (faits 2026-06-23)

- **L'UI ne ment plus sur les commandes (R8/R10)** : la tuile Portail attend la
  réponse et affiche « Échec — réessayer » + haptique si la commande ne passe pas
  (fini le fire-and-forget) ; la carte Cumulus affiche désormais l'anomalie du
  moteur (relais désynchronisé, boîtier injoignable…).
- **Anti-CSRF explicite (R15)** : `hooks.server.ts` bloque (403) toute commande
  mutante `/api/` déclenchée par un autre site (Fetch Metadata), en plus du
  `checkOrigin` SvelteKit. Endpoints token (portail/tick/monitor) non concernés.
- **Identifiants MQTT retirés du navigateur (R14)** : l'état Zigbee passe par un
  proxy SSE serveur (`zigbee-hub.ts` + `/api/zigbee/stream`) et les commandes par
  `/api/zigbee/set` (allow-list serveur : lumiere*atelier + imprimante). Plus aucun
  `PUBLIC_MQTT*_`(retirées du`.env`— toute var`PUBLIC\__` est servie au client).
  Fin de la fuite d'activité de la maison + des creds dans le bundle.

### Infra RPi4 (faite 2026-06-23)

- **EM-50 réparé** : son tunnel reverse pointait par erreur sur `.19` (vide) alors
  que le compteur est à `.54`. Re-ciblé sur son **nom mDNS**
  (`shellyproem50-08f9e0e768b4.local`) → **DHCP-proof** (joignable quelle que soit
  son IP future). Idem pour le tunnel du Shelly cumulus (`.20` → nom mDNS).
- **Schedules HA fantômes supprimés** du Shelly cumulus (le « OFF 08:00 » qui
  coupait le chauffe-eau chaque matin, + un reliquat dormant).

### Reste (infra Livebox — geste manuel)

- **Réservation DHCP de l'onduleur EZ1** (`.40`, MAC `34:98:7a:00:cb:5c`) : l'EZ1
  n'a pas de mDNS, sa robustesse finale passe par une réservation sur la Livebox
  (interface hostile à l'automatisation). **Mitigation en place** : le bridge cible
  `.40` de façon persistante (compose) et le moniteur **détecte + alerte +
  réconcilie** automatiquement toute future dérive. Pas de perte de données même
  si l'EZ1 rebouge.
