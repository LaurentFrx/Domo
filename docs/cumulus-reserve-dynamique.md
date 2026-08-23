# Cumulus — réserve dynamique de déclenchement

> Spécification issue de l'étude du 21-23/08/2026 (5 relevés de code et de mesures,
> 3 conceptions indépendantes, 3 critiques adversariales, 29 objections dont 9
> bloquantes). **Rien n'est implémenté** : ce document est là pour être discuté,
> puis exécuté par étapes vérifiables.

## 1. Le problème, mesuré

Le pilote ne sait pas calculer ce qu'il décide. Nulle part dans `pilot.ts` il
n'existe d'estimation de « combien de Wh et combien de temps le ballon va
chauffer » : les conditions d'allumage comparent des **puissances instantanées à
des seuils fixes**, et des **SoC à des pourcentages**.

Conséquences relevées sur les journaux du 13 au 21/08 :

| Verrou                        | Valeur       | Ticks de blocage | Effet réel                                                                 |
| ----------------------------- | ------------ | ---------------- | -------------------------------------------------------------------------- |
| `maxAcSocOnPct`               | 65 %         | **3 522**        | verrou dominant ; 0 allumage spontané les 13, 14, 15, 20 et 21/08          |
| `surplusOnW`                  | 2 000 W      | 896              | somme de charges instantanées, ne répond pas à « ai-je de quoi finir »     |
| `invisibleSurplusMinW`        | 2 000 W      | —                | **jamais armé** : maximum atteint 1 804 W depuis le 01/07                  |
| `battFullPct` / `chargeIdleW` | 90 % / 120 W | —                | `batteryChargeW < chargeIdleW` **toujours vrai** : le champ cloud vaut 0,0 |
| `batteryFloorCutPct`          | 40 %         | —                | coupe une chauffe **pendant qu'on injecte** (21/08 10:41, réseau à −45 W)  |
| `forecastFaibleKwh`           | 7 kWh        | —                | code mort : minimum journalier observé 12,11 kWh sur 68 jours              |

## 2. Plan comptable

Posé une fois pour toutes — c'est la faute la plus coûteuse des trois études :

- **toutes les énergies en Wh AC mesurés au compteur EM-50**, toutes les
  puissances en W AC ;
- une grandeur DC (registre batterie Max AC, PV DC) est convertie par
  `CONV_ETA = 0,95` **avant** d'entrer dans une inéquation ;
- toute grandeur non finie **fait échouer la condition** et incrémente un
  compteur journalisé. Jamais de repli silencieux à 0 : le piège
  `NaN >= surplusOnW` toujours faux a déjà tué une fonction en silence.

## 3. Le critère

### 3.1 Coût de la chauffe (Wh AC)

```
Ê_chauffe = clamp(250 ; 8000 ; a · max(0, T_coupure − T_sonde) + q(T_room) · ĥ)
```

| Terme       | Valeur                                | Origine                                                                                                          |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `a`         | 120 Wh/°C                             | régression sur 40-49 chauffes réelles ; contrôle physique : 348 / 2,68 = 130 Wh/°C (8 % d'écart)                 |
| `T_coupure` | `chargedAtTempC` sinon 55 °C          | `probeFullRestC`, retrouvé seul par les deux régressions (54,3 et 56,9 °C)                                       |
| `T_sonde`   | mesure                                | `zigbee2mqtt/thermo_cumulus` ; périmée au-delà de 1 800 s                                                        |
| `q(T_room)` | `40 + 2,1 · max(0, 24 − T_room)` Wh/h | 2,1 = `lossCoeffWhPerCh` (fiche Atlantic 154330). Nul sur toute la plage d'été mesurée : ne s'active qu'en hiver |
| `ĥ`         | h depuis le dernier plein             | **nouveau champ `lastFullEndTs`** : `lastAnchorTs` marque le _début_ du plateau, pas sa fin                      |

Validation croisée leave-one-out : **MAE 375-397 Wh**, contre 951 Wh pour le
déficit calorimétrique utilisé aujourd'hui et 1 032 Wh pour une constante.

Le terme temporel n'est pas un artifice : la sonde est au **point bas**, elle ne
voit le puisage par le haut qu'atténué d'un facteur 2,68. Sur la seule sonde, la
formule plafonne à ~3 500 Wh alors que la plus grosse chauffe mesurée fait
7 876 Wh — c'est `ĥ` qui porte l'écart.

### 3.2 Énergie utilisable du parc (Wh AC)

```
U_parc = Σ_packs  whPerPoint_i · max(0, SoC_i − reservePct) · CONV_ETA
```

`whPerPoint_i` est **appris en ligne** par intégration du registre batterie signé
sur les segments de décharge. Mesuré sur la Max AC : **65,0 Wh/pt**, contre 71,0
Wh/pt selon la plaque — l'écart vaut 1 462 Wh à parc plein, soit la totalité du
tampon. Filtre médian sur 3 échantillons : le SoC est un entier, ±65 Wh de
scintillement.

`U_i = 0` dès qu'une source est absente. Jamais de dernière valeur retenue.

### 3.3 PV attendu sur l'horizon (Wh AC)

```
Ê_PV = min( η_PV(T̂) · P_APS_min15 · (1 + k_SB) · ρ_forme · T̂ ; P_PV_plafond · T̂ )
```

- `P_APS_min15` = **minimum** sur 15 min, pas la moyenne : une moyenne reste haute
  quand un nuage arrive, c'est-à-dire quand le critère doit se fermer ;
- `η_PV(T̂) = 1 / (1 + T̂_min/105)` — p10 mesuré de la persistance sur 53 217
  fenêtres, un seul paramètre, écart maximal 0,03 sur 9 horizons ;
- `k_SB` = rapport horaire prévu (SB1+SB2)/APS, **avec garde** `Σ prev_aps ≥ 200 Wh`
  sinon repli 1,63, résultat borné [0 ; 3]. Sans cette garde, à 18h30 le pan Sud
  est à 0 et pas le pan Ouest : `k_SB = +∞`, le critère autorise tout ;
- `ρ_forme` porte le coucher de soleil et la rampe du matin. La prévision est
  biaisée de +39 % en valeur absolue mais **non biaisée en forme** (médiane du
  rapport réalisé/prévu = 0,96) : on n'utilise que sa forme.

### 3.4 Tampon (Wh AC)

```
Tampon = min( 3000 ; 1500 · f_météo · f_patience ) + E_maison_horizon
```

- **1 500 Wh** : donnée de l'énoncé. Corroborée — les usages concurrents de la
  maison pendant une chauffe valent 202 Wh en médiane, 656 au p90, **1 460 au
  maximum observé** ;
- `f_patience = clamp(windowLeftMin / (2·T̂_min) ; 1,0 ; 1,3)` : beaucoup de
  fenêtre devant ⇒ plus exigeant, on peut attendre un créneau franc ; dernière
  fenêtre du jour ⇒ marges relâchées. Continu ;
- `E_maison_horizon = max(0, P̄_maison_nuit · Δt(t → lever) − Ê_PV(t → lever))`,
  avec `P̄_maison_nuit = 256 W` mesuré sur 20 891 échantillons. **C'est la réserve
  du soir** : ≈ 0 en plein jour, ≈ 2,7 kWh à 19h30. Une grandeur continue en Wh,
  subordonnée à la chauffe — plus un plancher à 40 %.

### 3.5 Les inéquations

```
(C1) ÉNERGIE   U_parc + Ê_PV  ≥  Ê_besoin + Tampon
(C2) PUISSANCE  gain de pré-armement + marge Max AC − réseau  ≥  P_ballon_p95
(C3) MAINTIEN   (C1) réévaluée sur le RESTE de la chauffe  → sinon cession
(C4) RÉSIDU     le déficit mesuré de la dernière tentative s'ajoute au besoin
```

**(C2) ne crédite jamais une consigne absolue** : ce qui compte est
`gain = confirmé − base`. Un verdict `clamped` dont le gain est sous la bande
morte vaut `failed` du point de vue de la décision — la consigne était déjà au
plafond, le parc n'a rien donné de plus.

**(C3) n'est pas une inégalité indépendante** mais (C1) rejouée sur le reste :
fermer implique alors mécaniquement ne-pas-couper, et l'hystérésis est le progrès
de la chauffe, grandeur monotone. Sans cela, cycle limite garanti dès que le
ballon est tiède et le soleil franc.

**(C4) est le seul terme qui borne les tentatives.** Sans lui, un critère qui
échoue rejoue la même décision toutes les 900 s : mesuré le 15/08, **27 cycles de
65 s ON / 632 s OFF, 1 723 Wh achetés**.

## 4. Ce qui change

**Supprimés comme conditions d'allumage** : `maxAcSocOnPct`, `surplusOnW`,
`invisibleSurplusMinW` et toute la voie « surplus invisible », `battFullPct` /
`chargeIdleW`, `batteryFloorCutPct` (« réserve du soir » — remplacée par
`E_maison_horizon`), `batteryDropCutPts` (exprimé en Wh par (C3)),
`batteryMaxDischargeW` (déclaré, typé, annoté, **lu nulle part**).

**Corrigés** : `heatPowerW` 2 900 → **2 965 W** mesuré ; `maxPresetW` 2 400 →
plafond **appris** (faux de 600 W depuis le 10/08) ; `forecastFaibleKwh` 7 → 12 kWh ;
`minUsefulHeatMin` 45 min → `windowLeftMin ≥ T̂·60 + 15 min`.

**Conservé, rôle changé** : `exportOnW` 150 W devient la seule voie de secours
quand le Modbus Max AC est muet — elle ne lit ni le Modbus ni le cloud, elle
porte sa propre preuve physique.

**Intouchables, explicitement** : VETO EDF 500 W tous modes ; `cutBuyW` 150 W /
30 s ; `tmaxSondeC` 70 °C ; détection `tank_full` et `heater_fault` ;
`minOnSec` / `minOffSec` / `antiCyclingSec` ; watchdog Shelly ; `reservePct` 10 % ;
`observationBeforeOnSec` 120 s ; quota `solarStartsPerDay` 3 ; toute la voie HC.

## 5. Température extérieure et eau froide

Le code bascule aujourd'hui entre `inletSummerC = 15 °C` et `inletWinterC = 9 °C`.
Sur 300 L montés à 60 °C, cet écart vaut **2 093 Wh** : une marche de 2 kWh dans
l'estimation du besoin, déclenchée par le calendrier. C'est exactement ce que la
règle « aucun palier » proscrit.

Il n'existe aucune sonde d'eau froide. Mais la canalisation est enterrée : sa
température suit celle du sol, qui est la température de l'air **moyennée et
retardée** de plusieurs semaines. `T_inlet` sera donc estimée par une **moyenne
glissante amortie de `ext_c`**, continue, sans marche.

Ce terme ne peut pas être calibré sur les données disponibles — la base ne couvre
qu'un été, `T_int` n'a varié que de 4 °C en 64 jours — et il n'améliore rien
aujourd'hui. Il est posé par la physique, pas par l'ajustement, et sera vérifié
quand l'hiver aura fourni de l'amplitude.

## 6. Plan d'exécution

1. **Réparer ce qui rend tout critère inerte** — fait pour la boucle SB3
   (`625e408`, `029f22b`) ; reste l'absence du Modbus Max AC, qui bascule
   silencieusement sur un agrégat cloud où la Max AC n'apparaît plus depuis le
   10/08 : **7 100 Wh disparaissent du parc sans aucun signal**.
2. **Plomberie des entrées**, aucune décision changée : `ac_net_w` signé,
   `whPerPoint` appris, plafond SB3 et headroom publiés par la boucle.
3. **Critère en observation pure** — `criterion-shadow.ts`, sur le modèle de
   `desirability-shadow.ts` qui tourne déjà à chaque tick sans toucher au relais.
   Nouvelle table `criterion_samples` dans le recorder. **10 jours minimum.**
4. **Rejeu hors ligne** sur les 70 jours de `history.db`. Critère de passage : sur
   les 12 chauffes à parc entièrement observable, autoriser les 10 propres
   (48 Wh d'EDF cumulés) et refuser les 4 qui ont acheté ; aucune autorisation sur
   les 11 jours de Modbus muet, qui portent 7 083 des 12 400 Wh d'EDF.
5. **Bancs de mesure, relais ouvert, coût nul** : plafond Max AC par tranche de
   SoC sous sollicitation contrôlée ; constante de temps du parc **avec le
   matériel d'aujourd'hui** (les valeurs du code datent des bancs du 28-31/07, sur
   un parc dont les plafonds ont changé deux fois depuis) ; `lossCoeff` mesuré au
   compteur sur une nuit sans puisage.
6. **Mise en service progressive** : le critère devient une voie d'allumage
   **en OU** avec l'existant, les anciens seuils restant en place. Journalisation
   des allumages **refusés** avec leur cause — cela n'existe nulle part
   aujourd'hui, et c'est ce qui manque pour valider quoi que ce soit.
7. **Retrait des anciens seuils**, après 7 jours de service validés.

## 7. Ce que la validation devra prouver

- Chaque chauffe produit une ligne **Ê_chauffe estimé / E_cum réalisé**. Cela
  n'existe nulle part : `energy_samples` est un **miroir de l'état de Domo**
  relu par le recorder — toute validation conduite dessus est circulaire. Seule
  la voie 1 de l'EM-50 est extérieure au système.
- Pour chaque tick où le critère aurait autorisé alors que le pilote refusait :
  l'achat EDF **réellement mesuré** sur les 30 minutes suivantes doit rester nul.
- Rejeu de la journée du 15/08 : le critère doit s'arrêter après **au plus 2
  tentatives** (test de (C4)).
- Fuzzing NaN/Infinity sur chaque entrée : `clamp()` ne sanitise pas NaN,
  `Math.min/max` laissent passer Infinity.

## 8. Reste à trancher

- **Plancher de sécurité dur** du parc, une fois `batteryFloorCutPct` retiré.
- Le budget d'import par chauffe doit-il s'appliquer **aussi au boost manuel** ?
  Le boost passe aujourd'hui au-dessus du pilote et n'est retenu que par le VETO
  à 500 W : c'est par lui que sont passés les 1 723 Wh du 15/08.
- Trois sondes à ~25 € supprimeraient les trois paramètres les plus incertains :
  arrivée d'eau froide (`T_inlet` n'est mesurée par **rien** ; ±1 °C = ±350 Wh),
  local du ballon (`T_room` est aujourd'hui la moyenne salle de bains + salon),
  partie haute du ballon (la stratification varie d'un facteur 6 et c'est la
  première source d'erreur de l'estimateur).
- Deux points à vérifier dans l'app Anker : pourquoi la **Max AC n'est plus
  listée dans le compte cloud depuis le 10/08** (elle n'a plus qu'une source, un
  tunnel Modbus qui a été muet 11 jours d'affilée) ; et si le **plafond de sortie
  du site SB3 est un réglage** (2 400 → 1 600 → 1 800 W en trois semaines).
  En revanche il n'y a **pas** de bridage de la Max AC à chercher : elle a donné
  3 250 W le 22/08 et 2 020 W le 23/08.
