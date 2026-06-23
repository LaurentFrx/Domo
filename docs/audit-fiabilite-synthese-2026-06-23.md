# Audit de fiabilité Domo — Synthèse consolidée

**Date :** 2026-06-23
**Sources fusionnées :**

- **Audit A — code applicatif** : 7 analyses du code (`src/` + `record.py`) — persistence, détection de pannes, calculs, lifecycle stores, sécurité, runtime, commandes. Findings `R1…R31`.
- **Audit B — infrastructure** : observation directe RPi4 + VPS (scans réseau, configs, transport, base en `mode=ro`). Findings `C1…C3`, `M1…M5`, `V1…V6`.

Les deux ont été menés indépendamment le même jour. Cette synthèse les unifie **sans rien retrancher**, dédoublonne les recoupements, et utilise l'audit A pour **trancher 4 des 6 points « à vérifier » de l'audit B**.

---

## 1. Les deux audits sont deux étages du même bâtiment

|                | Audit B (infrastructure)                        | Audit A (code applicatif)                           |
| -------------- | ----------------------------------------------- | --------------------------------------------------- |
| **Regarde**    | DHCP, transport, bridges, config, observabilité | persistence, stores, calculs, sécurité, runtime, UI |
| **Voit**       | _pourquoi_ 3 chaînes ont cassé ensemble         | _comment_ l'app encaisse (mal) une brique tombée    |
| **Angle mort** | le code de l'app (assumé, « phase 2 »)          | l'infra LAN/transport (hors périmètre)              |

Ils ne se contredisent quasiment jamais ; ils **se complètent et se confirment**. Et ils énoncent **la même cause racine**, à deux niveaux.

---

## 2. Cause racine unique

> **Domo est une chaîne d'intégrations point-à-point qui repose sur des hypothèses implicites jamais vérifiées. Il n'existe aucune couche transverse qui _impose_, _réconcilie_ ou _surveille_ quoi que ce soit. Quand une hypothèse casse, le système ne le sait pas, ne le dit pas, et la donnée est perdue pour toujours.**

L'audit B formule la cause par **4 hypothèses implicites**, toutes tombées aujourd'hui :

|     | Hypothèse                                         | Réalité prouvée le 23/06                       |
| --- | ------------------------------------------------- | ---------------------------------------------- |
| H1  | Les appareils gardent leur IP                     | **Faux** — DHCP a renuméroté 3 appareils       |
| H2  | Les bridges répondent toujours juste              | **Faux** — APS : 0 / figé / NULL pendant ~14 h |
| H3  | La mesure instantanée suffit                      | **Faux** — chaque trou = perte définitive      |
| H4  | « Pas d'erreur dans les logs » = « tout va bien » | **Faux** — journald contredisait la base       |

L'audit A formule la **même** chose au niveau du code par **4 mécanismes de défaillance silencieuse** :

|     | Mécanisme                                                  | = Hypothèse |
| --- | ---------------------------------------------------------- | ----------- |
| A   | « Indisponible » compté comme `0` (APS, EM-50)             | H2/H3       |
| B   | Périmé affiché comme frais (tous les stores)               | H4          |
| C   | Échec de commande masqué (portail, cumulus, daikin)        | H4          |
| D   | Aucune surveillance transverse (`/api/health` = MQTT seul) | H4          |

**C'est le même défaut, vu du LAN puis vu du code.** Tout le reste en découle.

### La chaîne de bout en bout, avec le défaut à chaque étage

```
Appareils LAN (Shelly, EM50, EZ1, Daikin, Anker, Zigbee)
   │   ⚠ C1  IP DHCP dynamique, référencée EN DUR dans les configs
Bridges Python (Docker, RPi4)
   │   ⚠ M2  config qui ment (env_file inerte, IP désync, schedule HA fantôme)
   │   ⚠ M1  transport hybride (SSH reverse manuel + Tailscale partiel)
   │   ⚠ V3/R6  aucun garde-fou « valeur absente/figée/aberrante »
recorder (record.py → SQLite history.db, seul writer)
   │   ⚠ C2/R7  intègre l'INSTANTANÉ gated ; compteur cumulé ignoré → trou définitif
   │   ⚠ M4/R12 UPSERT additif sans idempotence par intervalle
   │   ⚠ R1/R4/V4  écritures non-fsync, AUCUN backup automatique
app Domo (SvelteKit)
   │   ⚠ R2/R3  parse non protégé (settings crashe) / silencieux (tariffs ment)
   │   ⚠ R13/R16 pas de handleError, process SPOF sans watchdog
   │   ⚠ C3/M5/R5  /api/health = MQTT seul ; 8 sources en angle mort
UI (stores + composants)
   │   ⚠ B/R9   périmé affiché comme frais (aucun âge)
   │   ⚠ C/R8/R10 échec de commande masqué (portail, cumulus, clim)
   │   ⚠ R14/R15 creds MQTT dans le bundle client ; CSRF applicatif absent
```

---

## 3. Registre consolidé des findings

Sévérité unifiée. Colonne **Réf.** = correspondance entre les deux audits. **Statut** : ✅ confirmé / ⚠ structurel / 🔍 à vérifier.

### 🔴 CRITIQUE — perte de données définitive / déclencheur / silence total

| Réf.                  | Finding                                                                                                                                                                                                                                                                                                                                                                                        | Statut |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **C1**                | **DHCP non maîtrisé** : 3 appareils renumérotés (Shelly .18→.20, EM50 .54→.19, EZ1 .35→.40), `.18`/`.35` re-squattées par d'autres devices → les forwards tapaient sur le **mauvais** appareil. **L'EZ1 n'a toujours pas de réservation → C1 se reproduira.**                                                                                                                                  | ✅     |
| **C2 ≡ R7**           | **Comptage par intégration instantanée, sans réconciliation** : `record.py:859,884` `aps_w if available else 0`, UPSERT additif jamais rétroactif ; `aps_lifetime_kwh`/`anker_lifetime_kwh`/`cumulusKwh` (compteurs cumulés) **stockés mais lus par aucun calcul**. Défaut sur **3 sources** (savings APS+Anker, énergie ballon). Perte du jour : 2,91 kWh / 0,67 € **définitifs**.            | ✅     |
| **R1+R2+R3+R4 (∼V4)** | **Persistence non durable & sans filet** : `writeFile`+`rename` **sans `fsync`** (coupure secteur → `settings.json`/`planning.json` vidé) ; `settings.json` corrompu → crash + orchestrateur cumulus à l'arrêt ; `tariffs.json` corrompu → baseline 498 € effacée **en silence** ; **aucun backup automatique**, `data/*.json` tous gitignored, 2 `.bak` de `history.db` manuels et obsolètes. | ✅     |
| **C3+M5 ≡ R5+R6+R9**  | **Défaillances silencieuses** : `/api/health` ne surveille **que MQTT** → 8 sources en angle mort (cause de la durée de l'incident) ; « indisponible » = `0` injecté dans agrégats **et historique** ; périmé affiché comme frais (aucun âge) ; **journald contredisait la base** (logs non fiables). 14 h d'aveuglement, zéro alerte.                                                         | ✅     |

### 🟠 MAJEUR

| Réf.              | Finding                                                                                                                                                                                                                                                                                                                                                                                                  | Statut         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **M2 + R22**      | **Config qui ment / dérive** : `docker-compose` APS **sans `env_file`** → `EZ1_BASE` inerte, bridge sur le défaut `.35` codé en dur ; forward EM50 sur `.54` (réservée non appliquée, réel `.19`) ; **schedule reliquat « OFF 08:00 » actif dans le Shelly** (coupe le cumulus hors logique Domo) ; doc `relay/+server.ts:5` cite `.18` ; **timer recorder : copie source `2min` ≠ unité active `30s`**. | ✅             |
| **M1**            | **Transport fragile et hybride** : SSH reverse manuel (`8099/8101/8102/8096/2222`, boucles crontab `@reboot`) **+** Tailscale partiel (`8095/8098/8100`). Deux systèmes inachevés, pièges non documentés (process qui garde l'ancienne commande après édition).                                                                                                                                          | ✅             |
| **R8 + R10**      | **Échec de commande masqué** : portail **fire-and-forget** (glow « OK » inconditionnel même si `503`/tunnel mort) ; cumulus `setManualRelay` ne resynchronise pas sur échec ; Daikin verrouille l'optimiste 12 s même sur `429` ; Airzone revient en arrière sans explication ; **`anomaly='desync'` calculée mais jamais affichée**. L'UI ment sur des actuateurs physiques.                            | ✅             |
| **M4 ≡ R12**      | **Écritures non idempotentes / non sérialisées** : `savings_daily` UPSERT additif dépendant d'un `last_ts` mutable (redémarrage/concurrence → double-comptage ou perte) ; `settings.json` écrit par 2 chemins (réglages **et** config cumulus) sans lock → lost-update ; `applyCommand` vs `tick`.                                                                                                       | ⚠/✅           |
| **R13+R16**       | **Runtime** : aucun `handleError` global + `request.json()` non gardé (settings/planning) → 500 brute, zéro observabilité ; **process web SPOF** `Restart=on-failure` (pas `always`), `WatchdogUSec=0` → un hang figé n'est jamais redémarré.                                                                                                                                                            | ✅             |
| **R14+R15 (≡V1)** | **Sécurité** : `PUBLIC_MQTT_*` (user `domo_web`) servis dans le **bundle client** → lecture de toute l'activité `zigbee2mqtt/#` (inférence d'occupation) ; **CSRF applicatif absent** sur les commandes d'actuateurs (dépend du seul défaut `checkOrigin` de SvelteKit).                                                                                                                                 | ✅             |
| **M3**            | **HA résiduel** : voir §4 — la suppression de HA (21/06) a laissé une **empreinte active dans les équipements** (le schedule 08:00 du Shelly).                                                                                                                                                                                                                                                           | ⚠ (à préciser) |

### 🟡 MOYEN / à durcir (extrait — détail dans `audit-fiabilite-2026-06-23.md`)

Fuites de timers PWA (`CumulusCard` sans `onDestroy`, singletons sans ref-count — R19) · `forecast`/`productionHistory` pollent en arrière-plan (R20) · `energy-model` n'annule pas les trous > 5 min (R17) · `coverage_pct` incohérent quand Anker tombe (R18) · triple source de tarifs HP/HC non commitée (R21) · `/api/settings` et commandes relayées sans validation/bornes (R23/R24) · mock Daikin/Airzone indistinguable du réel (R26) · reload de version non borné (R28) · idempotence portail asymétrique (R30) · **tests : 58 cas `node:test` mais cumulus uniquement, rien sur savings/routes/stores (V2)**.

---

## 4. Point à lever : « HA tourne-t-il encore ? »

**Contradiction entre sources.** La mémoire projet indique **HA entièrement supprimé du RPi4 le 21/06** (conteneur + image + config, action documentée). L'audit B affirme « HA tourne encore (transitoire) » et attribue le schedule Shelly à HA.

**Résolution la plus probable** : HA est bien supprimé, mais sa **suppression était incomplète au sens fonctionnel** — il a laissé un **schedule actif dans le Shelly lui-même** (`job3`, « OFF 08:00 »), qui survit à HA et **coupe le cumulus chaque matin hors de toute logique Domo**. Le problème concret (M2.3) est **confirmé et réel** quelle que soit l'issue. **À lever** : confirmer qu'aucun conteneur HA ne tourne réellement, et **supprimer le schedule reliquat** (`Schedule.Delete` id 3 sur le Shelly). C'est un cas d'école de « migration inachevée » : l'arrêt d'un système doit purger son empreinte dans les équipements.

---

## 5. Ce que la fusion résout (grounding des « à vérifier » de l'audit B)

L'audit A (code) **a déjà fait la phase 2** que l'audit B annonçait :

| Audit B                         | Verdict après audit A                                                                                                    | Réf.      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------- |
| **V1** CSRF sur routes mutantes | **Confirmé défaillant** : seul le portail a une garde explicite ; le reste dépend du défaut SvelteKit                    | R15       |
| **V2** Couverture de tests      | **Confirmé partiel** : 58 cas, **cumulus uniquement** ; rien sur savings/record.py, routes, stores, E2E                  | —         |
| **V3** Robustesse par bridge    | **Nuancé** : timeouts présents partout (point solide) **mais** aucun garde-fou « valeur absente/figée/aberrante »        | R6/R9/R26 |
| **V4** Sauvegardes              | **Confirmé absent** : zéro backup automatique (data + history.db), `.bak` manuels obsolètes, pas de test de restauration | R4        |
| **V5** États dégradés UI        | **Confirmé défaillant** : aucun état « périmé » distinct de « 0 » ; mock indistinct du réel                              | R9/R26    |
| **V6** MQTT WebSocket 502       | **Reste infra** : non couvert par l'audit code (à vérifier côté mosquitto/Caddy)                                         | —         |

→ 5 des 6 points sont désormais tranchés ; seul V6 reste à instrumenter côté infra.

---

## 6. Plan d'action unifié

Cible : **défense en profondeur** — chaque hypothèse imposée, vérifiée, et toute donnée réconciliable.

### ✅ Déjà fait dans la session (ne pas refaire)

- **Trou du 23/06 comblé** : `savings_daily` `+2,916 kWh / +0,676 €` (HP), avec **garde d'idempotence** (`manual_savings_fix`) → **ne pas re-appliquer**, le re-run est neutralisé.

### P0 — Stopper l'hémorragie (maintenant)

- [ ] **Réservation DHCP pour TOUS les appareils mesurés/pilotés** — priorité **EZ1 (.40, cause directe de C1/C2)** ; réaligner EM50 (réservation `.54` vs réel `.19`).
- [ ] **Supprimer le schedule Shelly « OFF 08:00 »** (reliquat HA) — `Schedule.Delete` id 3.
- [ ] **`fsync` avant `rename`** dans les 3 stores JSON (R1).
- [ ] **Backup automatique** `data/*.json` + `history.db` (+ `zigbee configuration.yaml` côté RPi4) **avec test de restauration** (R4/V4).

### P1 — Rendre les pannes VISIBLES

- [ ] **`/api/health` par bridge** : `available` + âge de la dernière mesure + valeur dans plage plausible ; bandeau qui **liste** les sources tombées (C3/M5/R5/R11).
- [ ] **Détection « figé / NULL / aberrant »** dans le recorder (ex. `lifetime` inchangé > 15 min en journée) → **alerte Web Push**.
- [ ] **`stale`/âge exposé et affiché** par store (priorité APS, EM-50, agrégats) ; afficher `anomaly`/`lastError`/échec HTTP ; **portail qui lit sa réponse** (R6/R8/R9/R10).
- [ ] **`handleError` global** + `request.json()` gardés (R13) ; **`Restart=always` + watchdog** (R16).
- [ ] **Corriger l'incohérence journald ↔ base** (C3) pour refiabiliser les logs.

### P2 — Rendre la donnée INCORRUPTIBLE

- [ ] **Réconciliation par compteur cumulé** : au retour d'un bridge, backfiller les économies depuis le saut de `lifetime` (la donnée le permet — l'aveuglement du jour était en soutirage, donc prod APS ~100 % autoconsommée). **Fix de fond de C2/R7.**
- [ ] **Écritures idempotentes/atomiques** : transaction par intervalle `[t0,t1]`, clé déterministe, anti double-comptage au redémarrage ; sérialiser les writes par fichier (M4/R12).
- [ ] **Parse protégé + quarantaine `.corrupt`** sur settings/tariffs (R2/R3).

### P3 — Durcir l'architecture (fond)

- [ ] **Transport unifié** : finir Tailscale, supprimer forwards SSH + boucles crontab (M1).
- [ ] **Indirection des endpoints** : source unique de vérité, **plus aucune IP en dur** (résolution par nom Tailscale/identité) — tue C1 à la racine.
- [ ] **Sortir HA du runtime** définitivement + purger ses empreintes (M3).
- [ ] **Retirer `PUBLIC_MQTT_*` du client** (proxy SSE Zigbee) + **anti-CSRF explicite** sur les commandes (R14/R15).
- [ ] **Tests** sur les chemins critiques **non couverts** : calcul d'économies, routes API (V2) ; **committer `tariffs.json`** + test d'égalité des 3 défauts (R21).
- [ ] Durcissements moyens : ref-count des stores (R19), visibility-gating forecast/productionHistory (R20), trous `energy-model` (R17), `coverage_pct` homogène (R18).

---

## 7. Annexe — ce qui est solide (les deux audits convergent)

**Le métier est sain ; le chantier est la couche de fiabilité autour, pas le cœur fonctionnel.**

- **Moteur cumulus** : watchdog matériel `toggle_after` réarmé chaque tick (vrai garde-fou de sécurité), relecture après commande, détection `desync`, anti-court-cycle, mutex + `withTimeout` ; **58 cas de test** sur `decide` et `energy-model`.
- **Auth** : deny-by-default, bypass-list en égalité stricte, `timingSafeEqual`, cookie HMAC, `no-store` global sur `/api/`, **position famille (findmy) verrouillée**, portail bien défendu côté serveur.
- **Architecture SvelteKit** : aucune `load` SSR → un bridge down **ne casse pas le rendu** ; tous les fetch serveur ont un timeout ; 3 endpoints SQLite robustes (readonly→rw, busy_timeout, finally close).
- **Normalisation défensive** exemplaire (`normalizeCumulusState`/`Planning`/`Config`) — **le bon modèle existe déjà dans le code, il faut le généraliser** à la persistence, aux sources et à l'UI.

---

_Documents liés : audit code détaillé → `audit-fiabilite-2026-06-23.md`. Statuts ✅ revérifiés en session ; ⚠ structurels ; 🔍 = V6 (MQTT) reste à instrumenter côté infra._
