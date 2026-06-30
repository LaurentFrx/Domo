# Installation énergie — fiche de référence (base du pilotage cumulus 2b)

> Inventaire COMPLET du matériel, des limites et des contraintes, construit par étapes
> avec Laurent. Sert de base au planificateur prédictif (étape 2b : délestage / décision
> sur surplus réel). Aucune valeur supposée : tout est confirmé par Laurent.
>
> État : étape 1 verrouillée · étapes 2–6 en cours.

## 1. Production solaire ✅ (verrouillée 2026-06-30)

**6 panneaux, 3 340 Wc crête, sur 3 onduleurs**, deux orientations :

| Onduleur            | Panneaux        | Orientation | Crête   | Écrêtage AC (sortie) |
| ------------------- | --------------- | ----------- | ------- | -------------------- |
| **APsystems EZ1**   | 2 × 585 Wc      | **Sud**     | 1 170 Wc | **900 W**            |
| **SolarBank #1**    | 2 × 585 Wc      | **Sud**     | 1 170 Wc | **1 200 W**          |
| **SolarBank #2**    | 2 × 500 Wc      | **Ouest**   | 1 000 Wc | **1 200 W**          |
| **Total**           | 6 panneaux      | Sud + Ouest | 3 340 Wc | **3 300 W** (somme)  |

- **Sud** = 4 × 585 = 2 340 Wc (EZ1 + SB#1, côte à côte) → produit surtout en milieu de journée.
- **Ouest** = 2 × 500 = 1 000 Wc (SB#2) → produit surtout en fin d'après-midi / soir.

**Implications clés pour le pilotage :**
- La puissance AC max **simultanée** (3 300 W) n'est **jamais atteinte** : le Sud pique à midi, l'Ouest l'après-midi. Pic réel observé ≈ **2 300–2 600 W** vers 13–15 h (concorde avec le forecast).
- ⚠️ **Le chauffe-eau tire 3 000 W**, soit **plus que la production solaire maximale**. Donc chauffer au cumulus implique **toujours** un appoint batterie et/ou réseau — il n'y a quasi jamais « 3 kW de soleil pur » disponible. → le « surplus » doit être calculé finement (PV − conso maison), pas supposé.
- L'EZ1 est **écrêté à 900 W** : au-delà, la production des 2 panneaux Sud est perdue (intéressant pour décider de consommer ce surplus plutôt que de l'écrêter).

## 2. Stockage — batteries SolarBank ✅ (verrouillée 2026-06-30)

2 SolarBank, **2,68 kWh chacune → 5,36 kWh** au total.

| Par SolarBank | Valeur                                   |
| ------------- | ---------------------------------------- |
| Capacité      | 2,68 kWh                                 |
| Charge max    | 1 800 W                                  |
| Décharge max  | **1 200 W**                              |
| SoC mini      | **10 %** (pas de plafond → charge 100 %) |

- **Énergie utile** (100 %→10 %) : 2,41 kWh / SolarBank → **4,82 kWh utile au total**.
- **Décharge max totale : 2 400 W** (1 200 × 2) — confirme la conf Domo `batteryMaxDischargeW = 2400`.
- **Stratégie Anker** : surplus → **maison d'abord, puis charge batterie** ; la nuit, **les batteries alimentent la maison jusqu'à 10 %**.

**Implications clés (déterminantes pour le pilotage) :**

- ⚠️ **Sortie AC max de TOUT le système ≈ 3 300 W** (EZ1 900 + SB1 1 200 + SB2 1 200), **batterie comprise** — plafond physique. Le cumulus tire 3 000 W : dès que la maison consomme ≥ ~300 W en parallèle, **on dépasse 3 300 W → import réseau inévitable** pendant la chauffe. Chauffer le cumulus n'est donc **jamais 100 % gratuit** s'il y a de la conso maison simultanée.
- ⚠️ **La batterie est la réserve du soir/nuit de la maison.** Mettre un kWh de batterie dans le cumulus = un kWh que la maison **rachètera au réseau plus tard** (elle se vide à 2,4 kW → 4,82 kWh épuisés en ~2 h). → le planificateur doit traiter la batterie comme **précieuse, pas gratuite**.
- Conséquence : le seul créneau vraiment **gratuit** pour le cumulus = **surplus PV réel instantané** (PV − conso maison), batterie déjà pleine. C'est précisément ce que le 2b doit mesurer.
## 3. Réseau & compteur ✅ (verrouillée 2026-06-30)

- **Abonnement EDF : 6 kVA** → limite d'import ≈ **6 000 W**. Au-delà → **disjonction**.
- **Tarif Heures Pleines / Heures Creuses** : HP **0,2318 €/kWh** · HC **0,1812 €/kWh** · creuses **00 h 06 → 08 h 06**.
- **Pas de revente** : le surplus PV non consommé est **perdu** (injection à 0 €).
- **Compteur EM‑50** : voie 0 = tout l'import/export réseau maison (signé), voie 1 = cumulus seul → **conso maison hors cumulus = voie 0 − voie 1**.

**Implications clés :**

- ⚠️ **Limite 6 000 W d'import** : cumulus 3 kW + induction 2,4 kW + maison ≈ 5,8 kW (sans soleil ni batterie) — **au ras du seuil**. Ajouter le four (~2 kW) ferait **disjoncter**. → le délestage du cumulus est aussi une **protection contre la coupure générale**.
- ✅ **Surplus perdu si non consommé** → mettre le surplus dans le cumulus vaut **toujours mieux que l'injecter** (perdu). MAIS c'est en **concurrence avec la charge batterie** (réserve du soir) : remplir le cumulus quand la batterie est ~pleine, sinon prioriser la batterie.
- La mesure **voie 0 − voie 1** est la donnée centrale du délestage (« surplus réel »).
## 4. Chauffe-eau ✅ (verrouillée 2026-06-30)

- **Atlantic réf 154330**, **300 L** vertical sur socle, résistance **3 000 W**, classe C.
- **Consigne thermostat : 59,2 °C** (coupure) ; l'inertie des résistances monte jusqu'à **59,5 °C** → c'est le « plein » (cohérent avec `setpointC = 59`).
- Pertes : `Cr 0,17` → `lossCoeff = 2,1` (calibré 2026-06-29) ; `Qpr 2,41 kWh/24h` ; capacité `tankWhPerC = 348 Wh/°C`.
- Sonde : **SNZB‑02LD** au point bas (doigt de gant), reporting reconfiguré à **0,2 °C**.
- **Commande : Shelly Pro 1 → contacteur de puissance 3 positions d'origine.** Les infos **HP/HC du Linky sont DÉCONNECTÉES** du contacteur.

**Implication MAJEURE :**

- ✅ **Le chauffe-eau est pilotable à TOUT MOMENT par le Shelly** (plus d'asservissement aux heures creuses du Linky). → la **chauffe solaire de midi est possible** ; chauffer la nuit en HC est un **choix économique**, pas une contrainte matérielle. Le planificateur a la **main complète** sur le « quand ».
## 5. Gros consommateurs ✅ (verrouillée 2026-06-30)

| Appareil                                              | Puissance typique         | Mesuré par Domo ?           |
| ----------------------------------------------------- | ------------------------- | --------------------------- |
| **Plaque induction**                                  | jusqu'à ~3–7 kW (vue 2,4) | ❌ non (câblée)             |
| **Four**                                              | ~2–3 kW                   | ❌ non (câblé)              |
| **Lave-linge / sèche-linge** (combiné)                | ~2–2,5 kW (chauffe)       | ✅ prise Zigbee `Lave-linge`|
| **Lave-vaisselle**                                    | ~1,8–2,2 kW (chauffe)     | ✅ prise Zigbee `Lave_vaisselle` |
| **Bouilloire**                                        | ~2 kW                     | ❌ non                     |
| **Micro-ondes**                                       | ~1 kW                     | ❌ non                     |
| **Clim réversible** Daikin (split salon) + Airzone (chambres) | variable, saisonnier | ❌ non                     |
| Voiture électrique                                    | —                         | aucune                      |

**Implications clés (capitales pour le 2b) :**

- ⚠️ Les **plus gros** (induction, four, clim Daikin/Airzone) sont **NON mesurés** → invisibles appareil par appareil. Seul le **compteur global EM‑50 voie 0** les capte.
- ✅ Donc le délestage **DOIT** s'appuyer sur la **conso maison réelle = voie 0 − voie 1** : elle capte TOUT (induction, four, clim, LL, LV…). C'est la grandeur fiable — pas besoin de connaître chaque appareil pour bien délester.
- La carte pourra **nommer** le lave-linge et le lave-vaisselle (mesurés) ; pour le reste, elle dira « forte consommation maison » sans détailler.
- ⚠️ **Clim réversible saisonnière** (été froid / hiver chaud) = poste lourd non mesuré → en été et en hiver la conso de base est nettement plus haute qu'à la mi-saison. Le délestage, basé sur le réel, s'y adapte tout seul.
## 6. Règles & contraintes d'usage ✅ (verrouillée 2026-06-30)

- **Besoin d'eau chaude** : 2 personnes, **2 douches/jour, le MATIN** (~7–8 h) en règle générale.
- **Réserve plancher : 2 douches** (≈ 4 kWh). Risque rare de manquer **accepté** → on attend le solaire au maximum.
- **Légionellose : NON prise en compte** (choix explicite de Laurent). Consigne reste **59 °C**, aucun cycle de surchauffe.
- **Absences / vacances : ARRÊT TOTAL** (relais off).
- **OBJECTIF GÉNÉRAL : minimiser la facture d'électricité** — toute optimisation de coût est bienvenue.

**Conséquences pour le pilotage :**

- Le besoin (2 douches) est le **MATIN**, le solaire arrive **l'après-midi** → cycle naturel visé : **recharge solaire l'après-midi → ballon plein le soir → 2 douches le lendemain matin** (les pertes nocturnes ~1 kWh laissent largement 2 douches au réveil).
- Repli : un jour **sans soleil** → si la réserve risque de tomber **sous 2 douches** avant le lendemain matin, **recharge en heures creuses la nuit** (avant 08 h 06), **jamais en heures pleines**.
- `reserveShowers` passe à **2** (était 3).
- **Ordre de préférence des sources** (du moins cher au plus cher) : **surplus PV réel** (gratuit, sinon perdu) **> heures creuses** (0,1812 €) **> [à éviter] heures pleines** (0,2318 €). La **batterie** n'est mobilisée pour le cumulus que si elle est ~pleine (sinon = simple report de l'import du soir).
- **Délestage** : ne pas chauffer quand la conso maison (induction/four/…) ne laisse pas de surplus réel, ni si l'import approcherait la limite **6 kVA**.

---

## Synthèse — ce que le pilotage 2b doit respecter

1. **Gratuit avant tout** : consommer le surplus PV réel (sinon perdu, pas de revente) — surtout batterie pleine.
2. **Batterie précieuse** : ne pas la vider pour le cumulus (réserve du soir).
3. **Délester** : pas de chauffe si la maison consomme (surplus réel ≤ 0) ou si on frôle 6 kVA.
4. **Garantir 2 douches le matin** : recharger la veille (solaire de préférence, HC sinon), jamais en HP.
5. **Plafond physique 3 300 W** de sortie système : la chauffe (3 kW) déborde dès qu'il y a de la conso maison.
