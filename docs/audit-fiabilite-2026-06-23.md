# Audit de fiabilité — Domo

**Date :** 2026-06-23
**Périmètre :** toute l'app (`src/` ~23 000 lignes, 26 stores, 26 routes API, 15 modules serveur), la persistence (`data/*.json` + `history.db`), et le service systemd `domo`.
**Méthode :** 7 analyses ciblées en parallèle (persistence, détection de pannes, calculs, lifecycle stores, sécurité, runtime, commandes), chaque finding ancré dans le code (`fichier:ligne`). Les points marqués ✅ ont été revérifiés manuellement.
**Élément déclencheur :** le 2026-06-23, le bridge APSystems est tombé ~5 h en renvoyant `available:false`/`0 W`. Le calcul d'économies a intégré 0 sans rien détecter ni signaler → trou de données définitif, découvert par hasard.

---

## 1. Verdict global

L'app a des **fondations saines** (moteur cumulus blindé, auth deny-by-default, aucune `load` SSR bloquante, tous les fetch serveur avec timeout). Le problème n'est **pas** l'architecture — c'est un **défaut systémique de posture face à l'échec** :

> **L'app est conçue pour le cas où tout fonctionne. Quand une brique tombe, l'échec est avalé en silence : la dernière valeur connue est servie comme si elle était fraîche, une absence est comptée comme un `0`, une commande qui échoue affiche quand même « OK ».**

L'incident APS n'est pas un accident isolé : c'est la manifestation d'un patron répété partout. La donnée d'échec **existe** presque toujours dans le code (`available`, `status`, `lastError`, `anomaly`, code HTTP) — elle n'est simplement **ni surveillée, ni affichée, ni utilisée pour protéger les calculs**.

Second axe de risque, distinct mais aussi grave : la **persistence n'est pas durable** (perte possible sur coupure de courant) et **sans filet** (aucun backup).

---

## 2. Le fil rouge — 4 mécanismes de défaillance silencieuse

| #   | Mécanisme                          | Où                                | Conséquence                                                        |
| --- | ---------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| A   | **« Indisponible » = `0`**         | APS, EM-50 cumulus                | Le 0 entre dans les agrégats **et l'historique** → faux définitif  |
| B   | **Périmé affiché comme frais**     | tous les stores                   | L'utilisateur croit voir le temps réel ; aucune indication d'âge   |
| C   | **Échec de commande masqué**       | portail, cumulus, daikin, airzone | L'UI affiche le succès optimiste même si le matériel n'a rien reçu |
| D   | **Aucune surveillance transverse** | `/api/health` = MQTT seul         | 8 sources sur 9 peuvent tomber sans déclencher la moindre alerte   |

Tout le reste de ce rapport décline ces 4 mécanismes, plus le volet persistence/runtime.

---

## 3. Findings CRITIQUES — perte de données, faux silencieux, sécurité physique

### R1 — Écritures non durables : une coupure de courant peut effacer tous les réglages ✅

`src/lib/server/settings-store.ts:40-42`, `planning-store.ts:198-200`, `cumulus/state-store.ts:178-180`
Les 3 stores font `writeFile(tmp)` puis `rename()` — bon geste pour l'atomicité **logique**, mais **aucun `fsync`**. `writeFile` n'écrit que dans le cache du noyau ; après une coupure secteur (le VPS en a déjà subi), le `rename` peut survivre alors que les blocs du fichier sont encore vides → `settings.json` de 0 octet ou rempli de `\0`. Le PUT a pourtant renvoyé 200 : l'utilisateur croit sa donnée sauvée.
**Impact :** perte définitive et silencieuse des réglages (prix, abonnement, phases, **toute la config cumulus** qui vit dans `settings.json`) ou du planning.
**Correctif :** `fs.open` → `fh.sync()` (fsync du tmp) avant `rename`, idéalement + fsync du répertoire `data/` après.

### R2 — `settings.json` corrompu : crash dur + orchestrateur cumulus à l'arrêt + auto-écrasement ✅

`src/lib/server/settings-store.ts:23-31`
`readSettings` n'attrape **que** `ENOENT` ; tout JSON corrompu (cf. R1) est **re-jeté**. Conséquences en cascade : GET `/api/settings` → 500 ; PUT → impossible de réparer (le merge lit d'abord, donc throw) ; et surtout `readCumulusConfig()` lit `settings.json` à **chaque tick** → `runTick` throw → **le pilotage du ballon s'arrête** tant que le fichier est corrompu, sans alerte autre qu'un 500 dans les logs.
**Correctif :** isoler le `JSON.parse` ; sur échec, **renommer le fichier en `.corrupt-<ts>`** (ne pas retourner `{}` aveuglément, sinon le prochain write écrase tout) + log visible + valider que le parse donne bien un objet.

### R3 — `tariffs.json` corrompu : la baseline et l'historique financier s'évaporent **sans aucun signal**

`src/lib/server/tariffs.ts:162-172`
À l'opposé de R2, `loadConfig` avale **tout** dans un `catch { return DEFAULT_CONFIG }`. Un fichier tronqué (édité à la main, hors atomicité) → retombe sur le défaut : baseline **à zéro** (498,67 € acquis disparaissent), import mensuel relevé au compteur effacé. Les pages Économies/Tableau mensuel affichent alors des chiffres **plausibles mais faux**, sans log ni erreur. C'est le mécanisme exact de l'incident APS, transposé aux tarifs.
**Correctif :** distinguer `ENOENT` (défaut légitime) de `parse error` (→ log d'erreur explicite, jamais un défaut muet sur des données financières).

### R4 — Aucun backup : tout incident d'intégrité est irrécupérable ✅

Vérifié : `data/{settings,planning,cumulus-state,tariffs}.json` **tous gitignored**, `git ls-files data/` vide, **aucun `.bak`**. `tariffs.json` contient des relevés Linky saisis à la main (12 mois) + la baseline ; `settings.json` les phases d'installation + la config cumulus calibrée — non reconstituables.
**Impact :** transforme R1/R2/R3 (et tout lost-update) en perte **définitive**.
**Correctif :** conserver la version N-1 en `.bak` avant chaque `rename` + sauvegarde périodique de `data/` hors VPS.

### R5 — `/api/health` ne surveille que MQTT : 8 sources sont des angles morts

`src/routes/api/health/+server.ts:17-19`, `src/lib/stores/health.svelte.ts:17-20`
Le bandeau d'alerte global ne se déclenche que sur `isMqttConnected()` (capteurs Zigbee/cumulus/portail). **APSystems, EM-50, Anker, Daikin, Airzone, Thermostat, Forecast, FindMy ne sont surveillés par rien.** C'est la **cause racine structurelle** de la durée de l'incident APS : aucune surveillance ne le couvrait.
**Correctif :** étendre `/api/health` pour sonder chaque bridge (server-side, timeout court) et renvoyer `{ source: {ok, ageS} }` ; le bandeau peut alors lister les sources tombées.

### R6 — « Indisponible » compté comme `0`, injecté dans les agrégats **et l'historique** (l'incident exact)

`src/lib/stores/apsystems.svelte.ts:56-58` (`available ? power_w : 0`), `production.svelte.ts:25-27`, `+page.svelte:24`, `CumulusCard.svelte:28`
Le `0` d'une source absente est indistinct d'un vrai 0. Il alimente le hero Production, le Sankey, **et le recorder `record.py`** → `history.db` → savings/ROI/autosuffisance. **La panne est gravée dans l'historique de façon permanente.** Idem EM-50 voie cumulus : `CumulusCard` lit `em50.cumulusPowerW` sans tester `em50.available` → voyant « Éteint » faux pendant que le ballon chauffe.
**Correctif :** distinguer `available:false` d'un 0 légitime (croiser l'élévation solaire pour l'APS) ; garder l'affichage cumulus sur `em50.available` ; ne jamais laisser un `0`-absent entrer dans un agrégat ou le recorder.

### R7 — La comptabilité intègre l'instantané gated, alors que des compteurs cumulés existent et sont ignorés

`domo-recorder/record.py:859-884` (savings), `src/lib/server/cumulus/energy-model.ts:144-146` (énergie ballon)
Le défaut générique, présent sur **3 sources** : `power_saved_w` part de `aps_w if available else 0` **+** `sb_ac (Anker) → 0 si injoignable`, puis intègre l'instantané. `injWh` du ballon intègre `cumulusPowerW` instantané. Or `aps_lifetime_kwh`, `anker_lifetime_kwh` et `cumulusKwh` (compteurs **monotones**, qui survivent à une panne) sont enregistrés mais **jamais utilisés pour le calcul**. Chaque indisponibilité de source = trou permanent et silencieux. (C'est précisément ce qui a produit le trou de 2,9 kWh ce jour.)
**Correctif :** dériver l'énergie du **delta de compteur cumulé** (borné anti-saut, comme `decide.ts:94` le fait déjà bien) ; à défaut, marquer l'intervalle comme « trou » (ne pas accumuler 0) quand la source est absente mais que le compteur progresse.

### R8 — Portail : aucune confirmation d'ouverture, échec totalement invisible

`src/lib/components/tiles/ZigbeeGenericTile.svelte:88-102`, `src/routes/api/portail/pulse/+server.ts:84-95`
`fetch(...).catch(console.error)` : le client **ne lit pas la réponse** et joue l'animation de succès (haptique + glow 3 s) **inconditionnellement**. Un `503 mqtt_unavailable` (tunnel `:9001` mort — cas déjà vu), `429`, ou `already_pulsing` → la tuile clignote « OK » alors que **le portail ne s'ouvre pas**. Pour un actuateur d'accès physique, un faux positif de succès est le pire mode de défaillance.
**Correctif :** `await` la réponse ; ne jouer l'animation « ouverture » que sur `200` sans `already_pulsing` ; sinon état d'échec explicite (teinte rouge + haptique d'erreur).

---

## 4. Findings ÉLEVÉS

### R9 — Donnée périmée présentée comme fraîche : aucun store n'expose son âge

Tous les stores. Le `catch` type (`apsystems:135`, `daikin:207`, `airzone:271`, `forecast:85`…) « garde le dernier état connu, signale juste l'erreur » — or `status`/`lastError` ne sont lus par **presque aucun** composant. Les timestamps (`ts`, `snapshotTs`, `fetchedAt`, `lastUpdate`) existent mais ne sont jamais affichés comme âge sur la donnée.
**Correctif :** exposer `stale`/`ageSeconds` par store, l'afficher (opacité/horodatage) dès péremption — priorité Sankey accueil, hero production, cartes climat/cumulus.

### R10 — La donnée d'échec des commandes existe partout mais n'est jamais affichée

`cumulus.svelte.ts:340-372` (H1), `daikin.svelte.ts:277-294` (H2), `airzone.svelte.ts:343-349` (H3), `engine.ts:84-99` (H4)

- **Cumulus `setManualRelay`** : sur échec HTTP, ne resynchronise pas `relayOn` et n'affiche pas d'erreur → optimisme « ON » persiste alors que rien n'a chauffé.
- **Daikin** : sur `429` Onecta (quota atteint), l'optimiste **reste verrouillé 12 s** ; la carte n'affiche pas `lastError` → l'UI ment, commande perdue présentée comme réussie.
- **Airzone** : mode optimiste sur toutes les zones, pin sur la master seule ; si le bridge rejette (`403` write-off), les 3 zones reviennent en arrière d'un coup au bout de 7 s, sans explication.
- **Cumulus `anomaly='desync'`** (relais qui ne suit pas l'ordre) est calculé, persisté, exposé par l'API… et **jamais affiché** sur `CumulusCard` (le label FR `'Relais désynchronisé'` existe pourtant). Un relais coincé ON en pleine HP s'affiche « En chauffe » comme si c'était voulu.
  **Correctif :** afficher `anomaly`/`lastError`/échec HTTP dans les cartes ; sur échec, libérer l'optimisme et resynchroniser l'état réel.

### R11 — `health` avale les 502/503 du serveur → bandeau jamais levé sur panne réelle de liaison

`src/lib/stores/health.svelte.ts:85-102`
Le store traite délibérément un fetch échoué comme « réseau du téléphone » et **ne touche pas `#downSince`**. Mais un `res.ok === false` (502/503 émis par le serveur Domo quand il ne joint pas le hub) tombe dans le **même** `catch` → `linkDown` reste `false`, **le bandeau ne s'allume pas** — exactement le signal qu'il est censé détecter.
**Correctif :** séparer `res && !res.ok` (serveur joignable, hub KO → armer `#downSince`) du vrai throw réseau.

### R12 — Aucune sérialisation des read-modify-write : lost updates silencieux

`settings-store.ts:34-43`, `engine.ts:209-229`
En Node mono-thread, deux requêtes qui s'entrelacent sur leurs `await fs` se écrasent. `settings.json` est écrit par **deux chemins** (réglages utilisateur **et** config cumulus via `writeCumulusConfig`) : un PUT settings concurrent d'un PUT cumulus/config → l'un des deux est perdu, malgré deux 200. Idem `applyCommand` (commande utilisateur) vs `tick` systemd sur `cumulus-state.json` : le mutex `ticking` protège le `tick()` mais **pas** le read-modify-write de la commande → un « Chauffer maintenant » peut être annulé par un tick concurrent.
**Correctif :** sérialiser les écritures par fichier (chaîne de promesses `lastWrite = lastWrite.then(...)` ou lock).

### R13 — Pas de `handleError` global + `request.json()` non gardé → 500 brute, zéro observabilité

`src/hooks.server.ts` (pas de `handleError`), `api/settings/+server.ts:10`, `api/planning/+server.ts:31`
Aucun filet d'erreur transverse : une exception non rattrapée → 500 générique + stack brute dans journald, sans message contrôlé. Et un corps non-JSON sur `settings`/`planning` PUT jette `SyntaxError` **avant** toute validation.
**Correctif :** `export const handleError` (log + message neutre) ; envelopper les `request.json()` (→ 400 `bad_json`).

### R14 — Identifiants MQTT servis en clair au navigateur

`src/lib/stores/zigbee.svelte.ts:13-17,145-152`
`PUBLIC_MQTT_USER`/`PUBLIC_MQTT_PASSWORD` (utilisateur `domo_web`) sont injectés dans le **bundle JS client**. Quiconque charge la page peut se connecter au broker en direct et **lire tout `zigbee2mqtt/#`** (états capteurs, ouvertures/fermetures → **inférence d'occupation du domicile**, utile à un cambrioleur) + écrire sur lumière atelier/imprimante. Le portail est exclu par l'ACL (bon point), mais la fuite d'activité reste réelle.
**Correctif :** proxifier le flux Zigbee navigateur via SSE serveur (même modèle que findmy) + endpoint POST gardé pour les rares écritures ; supprimer tout `PUBLIC_MQTT_*` du client.

### R15 — Commandes d'actuateurs sans anti-CSRF applicatif

`api/cumulus/relay`, `cumulus/command`, `thermostat/command`, `airzone/command`, `daikin/.../command`, `settings`
Ces écritures ne reposent que sur le cookie + le `checkOrigin` **par défaut** de SvelteKit. Seul `/api/portail/pulse` a une garde explicite (`x-domo-app`). La sécurité dépend d'un défaut de framework non rendu explicite : un futur handler CORS, un changement de config `csrf`, ou un Caddy qui réécrit l'`Origin` réintroduirait le risque (cookie `sameSite:lax` ne bloque pas une navigation top-level).
**Correctif :** appliquer le garde `x-domo-app` (ou un check `Origin`/`Sec-Fetch-Site` centralisé dans le hook) sur **toutes** les commandes.

### R16 — Process web : SPOF sans watchdog ✅

`deploy/domo.service` → `Restart=on-failure`, `WatchdogUSec=0`
`on-failure` ne couvre pas un arrêt code 0 ; surtout, **aucun watchdog** : un process **vivant mais figé** (deadlock, event-loop bloquée) n'est jamais détecté ni redémarré. Le watchdog tunnels et le timer cumulus couvrent l'infra, **pas** la disponibilité du web.
**Correctif :** `Restart=always` ; optionnellement `Type=notify` + `WatchdogSec` + heartbeat `sd_notify`.

### R17 — `energy-model` : un trou > 5 min n'est pas neutralisé → `E_avail` dérive

`src/lib/server/cumulus/energy-model.ts:137-138`
Contrairement au recorder (`MAX_GAP_S` → **pas d'intégration**), ici un gap est juste écrasé à 300 s et le bilan s'applique quand même. Après un redémarrage Domo de 30 min, on intègre 5 min d'injection/pertes au lieu de 0 → estimation « nombre de douches » faussée.
**Correctif :** sur `dt ≥ MAX_DT`, avancer `lastUpdateTs` sans appliquer inj/loss/draw (s'appuyer sur le recalage au prochain plein).

### R18 — `coverage_pct` incohérent quand l'Anker tombe

`src/routes/api/savings/+server.ts:157-162`, `record.py:461-467`
Le numérateur (auto-conso, origine cloud Anker) chute quand l'Anker est injoignable, mais le dénominateur (import) vient d'EM-50 (fiable, indépendant) → le « % solaire » devient faux dans les deux sens, sans signal.
**Correctif :** homogénéiser les sources du ratio (idéalement tout EM-50), ou neutraliser l'affichage quand l'Anker est indispo sur la fenêtre.

### R19 — Fuites de timers sur PWA longue durée

`src/lib/components/cards/CumulusCard.svelte:115-121` (3 pollers en `onMount`, **aucun `onDestroy`**), singletons sans ref-count
La carte démarre em50 + relais + orchestrateur et ne les libère pas elle-même — sauvée aujourd'hui par coïncidence d'emplacement. Posée ailleurs (Accueil, future page), chaque visite empile des intervalles jamais nettoyés. Plus largement, les stores sont des singletons connectés depuis le layout **et** les pages, sans compteur de références → un `disconnect()` de page peut couper un store encore utilisé ailleurs.
**Correctif :** `onDestroy` symétrique sur `CumulusCard` ; idéalement un helper `makePolledStore` avec ref-count (règle aussi la duplication des 6 implémentations de visibilité).

### R20 — `forecast` et `productionHistory` pollent en arrière-plan

`src/lib/stores/forecast.svelte.ts:51-62`, `productionHistory.svelte.ts:28-39`
Seuls 2 stores n'ont ni handler `visibilitychange` ni pause arrière-plan → ils fetch en continu PWA cachée (5 min / 2 min), contrairement au CLAUDE.md et au pattern de tous les autres.
**Correctif :** aligner sur le pattern `apsystems` (pause + refetch au retour).

---

## 5. Findings MOYENS

- **R21 — Triple source de tarifs HP/HC** (`tariffs.ts` / `tariffs.json` / `record.py`) maintenue à la main, et `tariffs.json` **non commité** → un déploiement neuf retombe sur les défauts codés en dur de chaque côté. Risque de divergence financière au prochain changement de régime. _Correctif :_ committer `tariffs.json` (ou le générer) + test d'égalité des 3 défauts.
- **R22 — Dérive de déploiement & angle mort opérationnel** ✅ : la copie source `~/domo-recorder/domo-recorder.timer` dit `2min`, l'unité **active** dit `30s`. `domo-cumulus`/`domo-recorder` sont hors CI/CD (auto-documenté) → ce qui tourne peut diverger du repo sans que rien ne le révèle. _Correctif :_ exposer un heartbeat « tick en retard » via `/api/health` (le state a déjà `lastTickTs`) ; réaligner les copies.
- **R23 — `/api/settings` PUT sans validation de schéma** (`Record<string,unknown>`, merge brut) → un client (ou CSRF si R15 tombe) écrit des clés arbitraires ; a déjà causé un crash de rendu par le passé (`each_key_duplicate`). _Correctif :_ allow-list de clés + bornes + taille max, comme `cumulus/config`.
- **R24 — Commandes relayées aux bridges sans bornes** (`setpoint` Airzone, `boost_minutes`/`config` thermostat, corps Daikin forwardé tel quel). _Correctif :_ borner les numériques côté Domo (défense en profondeur).
- **R25 — `cumulus-state` corrompu : récupération silencieuse** (`state-store.ts:169-171`) — robuste (ne plante pas) mais **sans log**, et le prochain write écrase l'historique (E*avail, anti-légionellose). \_Correctif :* logger + quarantaine `.corrupt`.
- **R26 — Mock Daikin/Airzone indistinguable du réel** : seeds affichés avant le 1er fetch / sur 503 sans marquage de provenance → consigne fantôme « 22 °C » sur une clim injoignable. _Correctif :_ filigrane « démo/hors ligne » ou gate sur `connected`/`mode`.
- **R27 — `setTimeout` non nettoyés** : `zigbee.pulse()` publie le OFF même après `disconnect()` (risque ON-sans-OFF sur un portail) ; `MatterClient._send` laisse un timeout 10 s pendant. _Correctif :_ stocker/clear les handles au teardown ; préférer `/api/portail/pulse` (ON→OFF serveur) pour le portail.
- **R28 — Reload de version non borné** (`+layout.svelte:30-34`) : si `version.json` ne « colle » jamais, chaque navigation recharge. _Correctif :_ mémoriser (sessionStorage) la version déjà rechargée.
- **R29 — `energy-model` fragilités numériques** : `averageTemp` propage un `NaN` d'entrée (protégé seulement par les appelants) ; `lossWh` dérivé de `tTank` lui-même dérivé de `eAvail` → biais auto-entretenu jusqu'au prochain recalage. _Correctif :_ `Number.isFinite` dans le reduce ; utiliser la sonde réelle pour `tTank` quand elle est fraîche.
- **R30 — Idempotence portail asymétrique** : verrou serveur 2 s vs glow client 3 s sans blocage du tap → un 2ᵉ tap à t+2,5 s déclenche une **2ᵉ impulsion réelle** (peut refermer le portail). _Correctif :_ aligner le verrou client sur la fenêtre serveur.
- **R31 — Mois `pv_samples` groupé en UTC, `savings_daily` en Paris** (`api/energy/monthly`) → léger décalage de bord de mois/année entre colonnes. Impact faible (nuit), à arbitrer.

---

## 6. Findings FAIBLES (synthèse)

Forecast : badge `+X kWh` reste figé à côté de « Prévision indisponible » (`fresh` jamais lu). · FindMy : positions sans âge, cache 24 h rejoué comme « live ». · Logs : IP client en clair (RGPD) + `detail` bridge remonté au client. · Cache `tariffs` invalidé sur `mtime` seul. · `printer.connect()` réarme un handler de visibilité en cas limite. · `lastError` de parse écrase l'erreur de connexion (zigbee/findmy). · Timeouts client parfois ≤ timeouts serveur (un client peut abandonner une commande lente-mais-réussie).

---

## 7. Points solides — à NE PAS casser

- **Moteur cumulus = référence de fiabilité** : relecture systématique après `Switch.Set`, **watchdog matériel `toggle_after`** (coupe le relais si Domo cesse de ré-armer), détection `desync`, anti-court-cycle, mutex `ticking` + `withTimeout(45s)`. La réalité du boîtier prime sur l'ordre.
- **Auth** : deny-by-default, bypass-list en **égalité stricte** (non élargissable), `timingSafeEqual` partout, cookie HMAC `httpOnly+secure+lax`, `no-store` global sur `/api/`, refus de démarrer si `AUTH_SECRET` < 16 car. **Position famille (findmy) verrouillée** (SSE serveur, aucun cred client) — l'ancienne fuite est bien fermée. **Portail bien défendu côté serveur** (double auth, rate-limit 6/min, verrou anti-double, QoS 1, POST-only).
- **Pas de `load` SSR** : toutes les données sont chargées côté client → un bridge down/lent **ne peut pas casser le rendu**. Meilleure défense possible.
- **Tous les fetch server-side ont un timeout** (`AbortSignal.timeout` / `AbortController`+clear) — aucun ne peut pendre indéfiniment.
- **3 endpoints SQLite robustes** : `fileMustExist` + repli readonly→rw, `busy_timeout`, `finally close`, 503 + payload neutre, messages d'erreur gardés côté serveur.
- **Normalisation défensive** exemplaire : `normalizeCumulusState`/`normalizeEnergyModel`/`normalizePlanning`/`normMonthlyMap` bornent chaque champ (le bon modèle, à généraliser à `settings-store` qui n'a aucune validation).
- **Anti-saut de compteur** (`decide.ts:94`, `record.py:478`) : la bonne approche cumulée — à étendre à R7.
- **DST/fuseau** rigoureux (découpage trapèze aux frontières HP/HC/jour), garde div/0 systématique sur les ratios, `COALESCE(SUM,0)` partout, conversions d'unités cohérentes.
- **Polling visibility-aware** + cadence Anker respectée (pas de risque de ban) sur la grande majorité des stores.
- **Optimisme/réconciliation** (pins Airzone, verrous Daikin, débounce consigne) bien pensés — le défaut est qu'ils masquent aussi les échecs (R10), pas leur conception.

---

## 8. Plan d'action priorisé

**Vague 1 — Stopper les pertes de données (jours).**

1. `fsync` avant `rename` dans les 3 stores **(R1)**.
2. Backup `.bak` (version N-1) + sauvegarde `data/` hors VPS **(R4)**.
3. `settings.json` / `tariffs.json` : parse protégé + quarantaine `.corrupt` + log, jamais de défaut muet **(R2, R3)**.
4. Comptabilité sur delta de compteur cumulé (ou marquage « trou ») pour APS/Anker/ballon **(R7)** — et combler le trou du jour est déjà fait.

**Vague 2 — Rendre les défaillances visibles (1-2 semaines).** 5. `/api/health` étendu à toutes les sources avec âge + bandeau qui les liste **(R5, R11)**. 6. `stale`/`ageSeconds` exposé et affiché par store (priorité APS, EM-50, agrégats) **(R6, R9)**. 7. Afficher `anomaly`/`lastError`/échec HTTP sur les cartes ; portail qui lit sa réponse **(R8, R10)**. 8. `handleError` global + `request.json()` gardés **(R13)** ; `Restart=always` + watchdog **(R16)**.

**Vague 3 — Durcissement (à planifier).** 9. Sérialiser les écritures fichier (R12) ; valider `/api/settings` (R23) et borner les commandes (R24). 10. Retirer `PUBLIC_MQTT_*` du client (proxy SSE Zigbee) (R14) ; anti-CSRF explicite sur les commandes (R15). 11. Committer/synchroniser `tariffs.json` + tests (R21) ; heartbeat « tick en retard » + réaligner les unités systemd (R22). 12. Neutraliser les trous dans `energy-model` (R17), homogénéiser `coverage_pct` (R18), ref-count des stores (R19), visibility-gating forecast/productionHistory (R20).

---

_Findings issus de 7 analyses parallèles ancrées dans le code ; points ✅ revérifiés manuellement. L'erreur d'un agent (timer recorder lu sur la copie source à 2 min) a été corrigée : l'unité active est à 30 s, mais la dérive source↔actif est elle-même retenue comme R22._
