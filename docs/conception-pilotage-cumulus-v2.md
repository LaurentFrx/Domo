# Conception v2 — Pilotage du chauffe-eau « comme la main de Laurent »

> **Statut : PROPOSITION à valider — rien n'est implémenté ni activé.**
> Le pilotage est en MANUEL + observation depuis le 02/07/2026 (échec v1 : le
> « maintien économique » tolérait 400-600 W d'import EDF permanent).

## 0. La règle constitutionnelle

**Le chauffe-eau ne crée JAMAIS de soutirage EDF.** Aucun critère économique
(« c'est moins cher que la HC ») ne peut la contourner. Les deux seules exceptions,
délibérées et bornées :

1. la **latence physique de démarrage** des SolarBank (~2-3 min de montée en
   puissance, ~80-150 Wh — la même qu'en pilotage manuel) ;
2. le **filet HC nocturne** (choix explicite : tarif bas, juste avant les douches).

La v1 a échoué en inversant la logique : elle optimisait un coût. La v2 imite un
geste : _allumer quand l'énergie est en train d'être jetée, couper dès que la maison
a besoin de la puissance._

---

## 1. Les paramètres d'entrée — exhaustif, par source

### 1.1 EM-50 (local, ~180 ms — LA vérité instantanée)

| Signal                                      | Usage                                                       | Fiabilité   |
| ------------------------------------------- | ----------------------------------------------------------- | ----------- |
| voie 0 : réseau signé (+ import / − export) | **Tout déclenchement et toute coupure**                     | Autoritaire |
| voie 1 : puissance cumulus                  | chauffe effective, détection thermostat (fin), calorimétrie | Autoritaire |

### 1.2 Anker SolarBank (cloud, **~60 s de retard** — jamais pour l'instantané)

| Signal              | Usage                                                                           | Piège                                       |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| SoC par batterie    | conditions de démarrage + garde batterie                                        | retard 60 s (acceptable : varie lentement)  |
| charging_power_w    | « les batteries n'absorbent plus »                                              | idem                                        |
| discharging_power_w | diagnostic (pas décisionnel)                                                    | idem                                        |
| solar_power_w       | **MENT quand les batteries sont pleines** (écrêtage : ne montre que la demande) | ne JAMAIS s'en servir pour juger le surplus |
| sb_output_power_w   | information (plafond 2400 W)                                                    | oscille ~2-4 min après un à-coup            |

### 1.3 APS EZ1 (local, 10 s)

`power_w` (pan Sud, écrêté 900 W) — injection directe, jamais stockée. Information.

### 1.4 Sondes température (Zigbee)

- `thermo_cumulus` (point bas, 0,2 °C/5 min) → E_avail calorimétrique (biais
  stratification ×2,8 corrigé — acquis v1 à conserver).
- T_room / T_ext moyennées multi-sources → pertes.

### 1.5 Dérivés du modèle (conservés de la v1)

- **E_avail** (Wh) et **réserve en douches** — jauge validée, recalée à chaque plein.
- **deficitWh** = ce qui manque pour 2 douches à 7 h 30 (pertes comprises).
- houseW (bilan) : **indicatif seulement** — dépend de l'Anker retardé, jamais décisionnel.

### 1.6 Tarifs & temps

HP 0,2318 / HC 0,1812 €/kWh ; HC 00 h 06 → 08 h 06 ; deadline douches ~7 h 30 ;
heure locale Paris.

### 1.7 Prévision PV (Météo-France, 30 min)

Utilisée UNIQUEMENT pour : (a) le filet HC (chauffer la nuit seulement si demain est
gris), (b) l'affichage. **Jamais pour déclencher une chauffe solaire** (la v1 a
montré que l'annonce météo ≠ le surplus réel).

### 1.8 Prises électroménager (Zigbee, MQTT)

Lave-vaisselle / lave-linge `power` → condition « maison calme » au démarrage +
journal. Le four/induction/bouilloire ne sont PAS mesurés individuellement → c'est
l'import EM-50 qui les représente (et il suffit).

### 1.9 État interne (mémoire de la machine)

Relais ON/OFF + depuis quand · anti-cycle (minOn 300 s / minOff 300 s /
antiCycling 600 s) · ballonCharged (thermostat) · **budget de démarrages solaires du
jour** · phase de la chauffe · compteurs regret (conservés).

---

## 2. La machine à états (remplace la décision sans mémoire)

```
                    ┌────────────────────────────────────────────┐
                    ▼                                            │
 REPOS ──(conditions §3 tenues 5 min)──► DÉMARRAGE ──(4 min)──► ÉTABLI
   ▲                                        │                    │
   │                                        │ import persiste    │ import dur >90s → CÉDÉ ─┐
   │                                        ▼                    │ SoC −5 pts     → CÉDÉ   │
   │                                      CÉDÉ ◄─────────────────┘ thermostat     → PLEIN  │
   │                                        │                                              │
   └──(anti-cycle purgé + conditions §3)────┴──────────────◄───────────────────────────────┘

 PLEIN ──(sonde −5 °C : puisage)──► REPOS
 FILET_HC : nuit, si déficit (indépendant du cycle solaire)
 MANUEL / VACANCES / BOOST : overrides absolus, à tout moment
```

| État                       | Relais | Ce qui s'y passe                                                                           |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| **REPOS**                  | off    | Surveille les conditions de démarrage (§3)                                                 |
| **ARMÉ** (interne à REPOS) | off    | Les conditions sont réunies : fenêtre d'observation de 5 min — un instantané ne suffit pas |
| **DÉMARRAGE**              | ON     | 0-4 min : latence SolarBank tolérée ; à 4 min, si l'import ne redescend pas → CÉDÉ         |
| **ÉTABLI**                 | ON     | Règle zéro import stricte (§5) jusqu'au thermostat                                         |
| **CÉDÉ**                   | off    | La maison a eu besoin de la puissance ; retour à REPOS après purge anti-cycle              |
| **PLEIN**                  | off    | Le thermostat a coupé (conso < 250 W confirmée) ; E_avail recalé = E_full                  |
| **FILET_HC**               | ON     | Nuit : chauffe dimensionnée au déficit, finit ~7 h 15                                      |

---

## 3. Conditions de DÉMARRAGE solaire — TOUTES cumulées, tenues 5 min

| #   | Condition                     | Valeur proposée                                         | Pourquoi (le geste manuel imité)                                                                             |
| --- | ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Ballon pas plein              | E_avail < 95 % E_full ET !ballonCharged                 | inutile sinon                                                                                                |
| 2   | **Injection franche mesurée** | grid EM-50 ≤ **−300 W en continu 5 min**                | la preuve directe que l'énergie est JETÉE ; la persistance filtre les pauses d'appareils et les instabilités |
| 3   | **Batteries pleines**         | SoC moyen ≥ 97 % ET charge < 120 W                      | on ne vole jamais la recharge ; batteries pleines = le surplus n'a plus d'autre destination                  |
| 4   | **Maison calme**              | prises LV/LL < 100 W ET l'injection franche le confirme | ne pas démarrer juste avant/pendant un cycle ; l'import EM-50 couvre le non-mesuré (four, plaques)           |
| 5   | **Fenêtre horaire**           | 10 h 30 – 16 h 30                                       | la chauffe démarrée doit avoir des heures de soleil devant elle — pas de chauffe qui finirait sur batterie   |
| 6   | **Budget du jour**            | ≤ 2 démarrages solaires                                 | protège la régulation SolarBank (les à-coups la font osciller) et le contacteur                              |
| 7   | Anti-cycle purgé              | minOff 300 s + antiCycling 600 s                        | inchangé v1                                                                                                  |

**Déclencheur secondaire (écrêtage invisible)** — cas réel du 02/07 : batteries
pleines, l'APS couvre juste la maison, grid ≈ 0, le potentiel SolarBank est écrêté
_sans injection visible_. Option proposée : les conditions 3+4+5+6+7 tenues 5 min
avec grid borné [−300 ; +50 W] déclenchent aussi. **→ question ouverte n° 2.**

## 4. Phase DÉMARRAGE (0 – 4 min)

Physique mesurée le 02/07 : les SolarBank mettent **2-3 min** à monter en puissance
(ON 12:59:23 → 2400 W à 13:02) ; l'import transitoire (~80-150 Wh) est inévitable —
**le pilotage manuel a exactement la même physique**. Surveillance : à 4 min, si
l'import reste > seuil dur → CÉDÉ immédiat (gros nuage pile au démarrage — rare si
la condition d'entrée « 5 min d'injection franche » était vraie).

## 5. Phase ÉTABLIE — la règle zéro import, opérationnalisée

| Événement mesuré                                                 | Réaction         | Délai                             | Justification                                                                                                                                              |
| ---------------------------------------------------------------- | ---------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Import > 150 W**                                               | CÉDÉ (coupe)     | après **90 s** continus (2 ticks) | la maison prime, TOUJOURS ; les 90 s absorbent les oscillations SolarBank mesurées (~1-2 ticks) sans tolérer un vrai pic (four, bouilloire, LV)            |
| Import ≤ 150 W                                                   | on continue      | —                                 | zéro import respecté                                                                                                                                       |
| **SoC chute de 5 points** depuis le début de chauffe (ou < 93 %) | CÉDÉ             | ~3 min de confirmation            | le PV ne couvre plus la chauffe : elle « tourne sur batterie » sans que le grid le voie (l'import reste nul !) — c'est la protection de ta réserve du soir |
| **Conso cumulus < 250 W** (relais ON) confirmée 2 min            | PLEIN            | —                                 | le thermostat mécanique a coupé : mission accomplie, E_avail = E_full                                                                                      |
| Sonde ≥ 70 °C                                                    | coupe (sécurité) | immédiat                          | filet ultime, inchangé                                                                                                                                     |

Nuage intermittent en ÉTABLI : le PV chute → les SolarBank (pleins) compensent →
l'import reste ~0 → **pas de coupure** (correct : rien n'est soutiré). Si le nuage
dure, c'est le garde SoC (−5 pts) qui coupe proprement. Fini le ping-pong de la v1.

## 6. FILET_HC (nuit) — inchangé v1, il était bon

- Déclenchement : déficit > 0 pour 7 h 30 ET pas de couverture solaire possible.
- Démarrage au **backstop calculé** (7 h 30 − durée du déficit − 15 min) → l'eau
  finit de chauffer juste avant les douches (pertes minimales).
- Coupure : déficit couvert OU thermostat OU 7 h 30. Jamais la batterie la nuit.
- Modulation météo : rien à faire — si demain est radieux, le déficit résiduel est
  petit et la chauffe HC courte ; le dimensionnement au déficit s'en charge seul.

## 7. Overrides et filets (inchangés, hors de portée de l'optimiseur)

- **MANUEL** : l'interrupteur de la carte, priorité absolue. **VACANCES** : tout coupé.
- **BOOST** (« Chauffer maintenant ») : chauffe immédiate jusqu'au plein — l'EDF est
  accepté car c'est un choix humain explicite (invités, etc.).
- **Filet famille** : réserve < 1 douche → chauffe immédiate quelle que soit l'heure.
  **→ question ouverte n° 1** (ou préférer attendre la HC ?).
- Sécurité 70 °C · anti-cycle · watchdog Shelly (coupure auto si Domo meurt) ·
  relais injoignable → aucun ordre.

## 8. Modes dégradés (aucune donnée n'est indispensable)

| Panne               | Comportement                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EM-50 muet**      | AUCUNE chauffe solaire (le signal de vérité manque) ; filet HC seul                                                                                               |
| **Anker muet**      | démarrage possible sur injection franche EM-50 seule (elle n'en dépend pas) ; garde SoC indisponible → fenêtre horaire resserrée (10 h 30 – 15 h) en compensation |
| Sonde ballon muette | E_avail dérive bornée (recalages impossibles) → filet HC conservateur, pas de solaire au-delà de 48 h sans sonde                                                  |
| Relais injoignable  | aucun ordre ; anomalie affichée                                                                                                                                   |
| MQTT down           | comme sonde muette + prises invisibles (l'import EM-50 couvre)                                                                                                    |

Le pire système possible reste « chauffe HC finissant 7 h 15 » — déjà correct.

## 9. Matrice de scénarios (les interactions, de bout en bout)

| #   | Scénario                                             | Déroulé v2                                                                                                                                                                         |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Été radieux, maison calme**                        | Batteries pleines ~11 h → injection franche 5 min → 1 chauffe ~11 h 15 → thermostat ~13-14 h → PLEIN. Import total : la seule montée SB (~100 Wh). C'est ta journée manuelle type. |
| S2  | **Lave-vaisselle pendant la chauffe**                | LV tire 2 kW → import > 150 W → 90 s → CÉDÉ. Fin du cycle LV → injection franche revient 5 min → 2ᵉ démarrage (budget 2/2) → thermostat.                                           |
| S3  | **Nuages intermittents**                             | En ÉTABLI : les SB compensent, import ~0 → pas de coupure. Nuage long → SoC −5 pts → CÉDÉ propre. Pas de ping-pong.                                                                |
| S4  | **Journée grise**                                    | Jamais 5 min d'injection franche → zéro chauffe solaire → FILET_HC à l'aube, dimensionné au déficit. Douches garanties, EDF au tarif plancher.                                     |
| S5  | **Matin, batteries à 60 % en charge**                | Pas de démarrage (le surplus va dans les batteries, rien n'est perdu). On attend le plein.                                                                                         |
| S6  | **17 h 30, injection franche**                       | Fenêtre horaire fermée → pas de démarrage (la chauffe finirait sur batterie). Le surplus du soir est perdu — comme en manuel. **→ question ouverte n° 3.**                         |
| S7  | **Douches d'invités à 20 h**                         | Réserve chute → rien la nuit (batterie intouchable) → FILET_HC à l'aube couvre. Réserve < 1 douche → filet famille (selon q. n° 1).                                                |
| S8  | **Repas (four + plaques) pendant la chauffe**        | Import massif → CÉDÉ en 90 s. Toute la puissance à la maison.                                                                                                                      |
| S9  | **Ballon plein à 13 h 30**                           | PLEIN (thermostat), tout s'arrête ; le surplus repart en injection — mission accomplie.                                                                                            |
| S10 | **Chauffe manuelle par toi**                         | MANUEL prime ; le moteur observe, journalise, compte le regret — il n'interfère jamais.                                                                                            |
| S11 | **Hiver**                                            | Batteries rarement pleines → conditions solaires rares → le FILET_HC porte la charge (eDouche 2800 Wh, tInlet 9 °C déjà saisonniers) ; chauffe solaire les beaux jours seulement.  |
| S12 | **Écrêtage invisible** (batteries pleines, grid ≈ 0) | Selon la question ouverte n° 2 : soit on rate ce surplus (conservateur), soit le déclencheur secondaire le capte avec les mêmes garde-fous.                                        |

## 10. Ce qui est conservé de la v1 (acquis validés)

E_avail calorimétrique + réserve en douches · filet HC dimensionné/backstop ·
boucle de regret (le juge, en €) · journal du jour + appareils nommés · carte
« Eau chaude » (hiérarchie 3 niveaux) · invariants decide.ts · sondes/latences
documentées (EM-50 180 ms, Anker 60 s, montée SB 2-3 min, oscillation SB 2-4 min).

## 11. Récapitulatif des paramètres (tous ajustables dans /reglages ensuite)

| Paramètre                     | Valeur proposée                                              |
| ----------------------------- | ------------------------------------------------------------ |
| Injection franche (démarrage) | ≥ 300 W pendant 5 min                                        |
| Batteries pleines             | SoC ≥ 97 % et charge < 120 W                                 |
| Maison calme                  | prises LV/LL < 100 W                                         |
| Fenêtre horaire solaire       | 10 h 30 – 16 h 30                                            |
| Budget démarrages solaires    | 2 / jour                                                     |
| Grâce de démarrage            | 4 min                                                        |
| Import dur (coupure)          | > 150 W pendant 90 s                                         |
| Garde batterie                | SoC −5 points depuis le début (ou < 93 %)                    |
| Ballon plein                  | E_avail ≥ 95 % E_full, ou thermostat (conso < 250 W / 2 min) |
| Filet HC                      | backstop = 7 h 30 − durée déficit − 15 min                   |
| Filet famille                 | réserve < 1 douche (question n° 1)                           |

## 12. Questions ouvertes (à trancher AVANT le code)

1. **Filet famille** — réserve < 1 douche un après-midi gris : chauffer immédiatement
   en HP (eau garantie, ~0,60 €) ou attendre le filet HC de la nuit (risque : douche
   du soir froide) ?
2. **Écrêtage invisible** — activer le déclencheur secondaire (batteries pleines +
   grid ≈ 0 + mêmes garde-fous) pour capter le surplus que l'injection ne montre
   pas ? Recommandation : oui, il est aussi sûr que le principal.
3. **Fenêtre horaire** — 10 h 30–16 h 30 te convient ? (le pan Ouest produit tard
   l'été : on peut élargir à 17 h en plein été.)
4. **Budget** — 2 démarrages solaires/jour, c'est ton geste ?
5. **Seuils** — injection franche 300 W/5 min ; import dur 150 W/90 s : à ajuster ?

---

_Validation attendue de Laurent avant toute implémentation. Le pilotage reste en
MANUEL + observation d'ici là._
