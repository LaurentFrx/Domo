# Chauffage Salle de bain (sèche-serviette) — Conception & roadmap

> Préparer l'hiver **2026‑2027**. Document de référence : la conception court sur
> plusieurs mois, à reprendre par phases. Cadrage figé le **2026‑06‑08**.

## Objectif

Doter le **sèche-serviette de la salle de bain** d'un thermostat intelligent type
**Versatile Thermostat (HA)** — switch on/off, presets éco/confort, régulation de
température — **piloté par un planning calendaire** (calendrier scolaire + jours
fériés + agenda Google de Laurent + planning de travail d'Isabelle), le tout dans
un **daemon serveur 24/7** (fonctionne dashboard fermé).

## Décisions cadrées (2026‑06‑08)

| Sujet                                  | Décision                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Régulation                             | Type Versatile Thermostat, **reconstruite** (TPI + presets + sécurités).                                                               |
| Liaison HA                             | **AUCUNE.** Ni extraction, ni dépendance runtime. Tout est reconstruit.                                                                |
| Exécution                              | **Daemon serveur 24/7** sur le RPi4 (modèle B, tunnelisé vers le VPS).                                                                 |
| Calendriers Google                     | API **Google OAuth** (lecture) : « Vacances scolaires » (zone A), « Jours fériés France », agenda `wakawarider@gmail.com`.             |
| Planning d'Isabelle                    | **Page dédiée dans Domo**, designée **iPad**, accessible depuis Réglages. Pas Google, pas HA.                                          |
| Optimisation énergie (HC / surplus PV) | Sans préférence forte → **phase tardive, optionnelle**.                                                                                |
| Matériel sèche-serviette               | **Thermostat intégré** (confirmé 2026‑06‑08) → à régler **au maximum** ; le daemon régule par PWM d'alimentation via le Sonoff node 1. |

## Briques déjà fournies par Domo (réutilisables)

- **Actionneur** : switch Matter **node 1** « Sèche-serviette » / SdB, on/off pur
  (`turnOn(1)`/`turnOff(1)`) — `src/lib/stores/matter.svelte.ts:59`.
- **Sonde** : `Thermo SdB` (SNZB‑02), `.state.temperature` + `.humidity` via MQTT
  — `src/lib/stores/zigbee.svelte.ts:42`.
- **T° extérieure** dispo : capteur Zigbee `Thermo_ext` (MQTT) et/ou météo Open‑Meteo.
- **Modèle d'orchestration** : cumulus (presets, hystérésis, anti-cycling, plage HC,
  coût HC/HP) — `src/lib/stores/cumulus.svelte.ts` (⚠️ encore `mode: 'mock'`).
- **Persistance config** : `data/settings.json` (merge atomique, structure ouverte)
  — `src/lib/server/settings-store.ts`.
- **Patron d'intégration « modèle B »** : bridge loopback → route `status`/`command`
  → store visibility-aware → carte (cf. airzone / daikin).

## Contrainte d'architecture (importante)

Les stores `matter` et `zigbee` sont **navigateur uniquement**
(`if (typeof window === 'undefined') return`). Le daemon **ne peut pas** s'appuyer
dessus : il parle **directement** à

- `python-matter-server` (WebSocket) pour commander le switch node 1 ;
- **mosquitto** (MQTT interne `ws://127.0.0.1:9001`, déjà utilisé serveur-side pour
  le portail) pour lire `Thermo SdB` et `Thermo_ext`.

> Aucun orchestrateur serveur réel n'existe encore (le cumulus est mock). Ce daemon
> sera **le premier**, et son patron resservira ensuite à passer le cumulus en réel.

## Architecture cible

```
            ┌──────────────────────── RPi4 ────────────────────────┐
   MQTT ───▶│  thermostat-bridge (daemon Python, loopback :8101)     │
 (Thermo    │   • lit T° SdB + T° ext (paho-mqtt)                    │──┐
  SdB/ext)  │   • lit agendas Google (OAuth, calendar.readonly)      │  │ tunnel -R
            │   • applique le moteur de planning → preset cible      │  │ 127.0.0.1:8101
            │   • régule en TPI → ON/OFF                             │  │
   Matter ◀─│   • commande node 1 (client python-matter-server / WS) │  ▼
  (node 1)  │   • expose /status (GET) + /command (POST)             │ VPS ──▶ Domo
            └───────────────────────────────────────────────────────┘  /api/thermostat/*
```

**Côté Domo** : route `/api/thermostat/{status,command}` → store
`thermostat.svelte.ts` (polling visibility-aware) → **carte** (façon `CumulusCard`)
sur `/climat` + **section config** dans `/reglages` + **page planning** iPad.

Le **planning d'Isabelle** (saisi dans Domo) est persisté dans `settings.json`
(ou `data/planning.json`) et **poussé au daemon** via `/command` à chaque changement
(le daemon n'a pas accès au disque du VPS) ; le daemon le combine avec les agendas
Google.

## Régulation (algorithme TPI, façon VTherm)

Cycle lent (`cycle ≈ 5 min`, ajustable) → PWM tout-ou-rien :

```
on_percent = clamp01( coef_int·(T_cible − T_pièce) + coef_ext·(T_cible − T_ext) )
ON pendant  on_percent · cycle   puis  OFF le reste du cycle
```

- `coef_int` (défaut ≈ 0.6) : réactivité à l'écart intérieur.
- `coef_ext` (défaut ≈ 0.01) : compensation des pertes (via T° ext).
- Évolution possible : terme d'auto-régulation (annule le biais résiduel).

**Presets** (températures par défaut, à régler) : Hors‑gel ≈ 7 °C · Éco ≈ 16 °C ·
Confort ≈ 22 °C · Boost = confort +qq °C pendant une durée limitée puis retour.

**Sécurités** : détection fenêtre ouverte (chute rapide de T° → coupe X min) ·
butées min/max · watchdog sonde (Thermo SdB muet → repli sûr + notif Moshi) ·
anti micro-cycles.

## Moteur de planning

Combine, par tranche horaire, → **preset cible** :

- **Type de jour** : jour d'école (scolaire zone A) vs vacances vs férié vs week-end.
- **Présence** : planning d'Isabelle (Domo) + événements agenda Laurent (Google).
- **Créneaux de confort** : matin (heure de début adaptée au lever réel : école /
  Isabelle au travail / event tôt) + soir (douche). Hors créneaux → éco le jour,
  hors‑gel la nuit.
- **Anticipation** : pré-chauffe avant l'heure cible (paramètre simple, puis estimation
  d'inertie).
- **Override manuel** depuis l'app (boost / forcer / éteindre) avec **expiration**
  (jusqu'à la prochaine transition planning ou durée fixe).

## Roadmap par phases

- **Phase 0 — Vérifs matériel** _(possible dès maintenant)_
  Nature du sèche-serviette (résistance simple / thermostat interne / fil pilote — la
  régulation par PWM d'alim suppose un thermostat interne à fond ou absent). Confirmer
  que node 1 coupe bien l'alim. Cadence d'émission de `Thermo SdB`. Réserver port
  loopback **8101** + tunnel. Choisir le langage du daemon (**Python recommandé**,
  cohérent avec forecast/apsystems).
- **Phase 1 — Daemon + régulation TPI (thermostat manuel)**
  Daemon RPi4 : MQTT in, matter-server out, boucle TPI sur un preset choisi à la main,
  sécurités de base, `/status` + `/command`. Côté Domo : routes + store + carte sur
  `/climat`. ⇒ thermostat réel, piloté manuellement (presets + boost).
- **Phase 2 — Config éditable**
  Presets, coef_int/coef_ext, cycle, durée boost, butées, seuils fenêtre dans
  `settings.json` ; section dans `/reglages` ; poussée au daemon.
- **Phase 3 — Page Planning (UI iPad)**
  Page dédiée (accès Réglages), grille hebdo designée iPad (semaine type + exceptions),
  stockage `data/planning.json`. Respect du design system (verre plexiglass, OKLCH,
  iPad paysage). _Indépendante des phases 1‑2._
- **Phase 4 — Intégration Google (OAuth) dans le daemon**
  Bridge OAuth (façon Daikin/Onecta) : lecture scolaire zone A + fériés + agenda Laurent.
- **Phase 5 — Moteur de planning (auto)**
  Combine planning Isabelle + agendas → preset cible ; mode auto + override manuel ;
  affichage « preset actif + raison + prochain créneau » sur la carte.
- **Phase 6 — Optimisation énergie** _(optionnel)_
  Pré-chauffe HC + opportunisme surplus PV (réutilise les seuils façon cumulus).
- **Phase 7 — Finitions**
  Historique T°/puissance (sparkline) ; notifications anomalies ; **cohabitation du
  toggle manuel `/pieces`** (le router via le daemon en override pour éviter que la
  régulation l'écrase).

## Points à vérifier / décisions ouvertes

- [x] Nature du sèche-serviette : **thermostat intégré** → le régler au max (sinon il « fighte » le PWM). _(confirmé 2026‑06‑08)_
- [ ] Langage du daemon (Python recommandé) — à confirmer.
- [ ] Modèle de données du planning : semaine type + exceptions ponctuelles (proposé).
- [ ] Valeurs des presets SdB (confort plus élevé qu'une pièce de vie).
- [ ] Stratégie d'anticipation (paramètre fixe d'abord, estimation d'inertie ensuite).
