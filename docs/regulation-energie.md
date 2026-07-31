# Régulation de l'énergie — étude, démonstrations, réglages

_Étude du 28/07/2026. Toutes les valeurs numériques citées sont soit **mesurées**
sur `history.db` (141 019 points, 8 semaines) ou sur le matériel, soit **démontrées**
(SymPy) ou **simulées** (Monte Carlo apparié). Les scripts sont reproductibles._

---

## 0. Les trois règles, et ce qu'elles imposent

Laurent a posé trois règles absolues (fiche mémoire `RULES_ENERGIE_LAURENT`) :

1. **Ne jamais soutirer sur EDF.** Aucune convention ne bloque jamais la décharge.
2. **Répartition au prorata de l'énergie utilisable**, réserve 10 % déduite.
3. **Aucun palier, aucune réaction différée.**

Ce document montre que la règle 2 est **démontrable** (ce n'est pas un choix
esthétique), que la règle 3 est **atteignable sans instabilité** à condition
d'utiliser le bon outil, et que la loi actuellement en service viole la règle 3
en pratique tout en croyant l'appliquer.

---

## 1. Le système, en grandeurs physiques

| Élément                       | Rôle                     | Commandable ?                                     | Mesure                               |
| ----------------------------- | ------------------------ | ------------------------------------------------- | ------------------------------------ |
| **2 × Solarbank 3 E2700 Pro** | 2 × 2 688 Wh, PV propre  | consigne AC 0–2 400 W, **via le cloud Anker**     | SoC + sortie (cloud, retard 1–3 min) |
| **Solarbank Max AC**          | 7 200 Wh, **3 540 W AC** | **non** — asservit le compteur à zéro toute seule | Modbus **local**, ~2 s               |
| **Onduleur APS EZ1**          | PV AC, 0–960 W           | plafond, **local**                                | local, ~10 s                         |
| **Compteur Shelly EM-50**     | réseau signé             | —                                                 | **local, instantané**                |

Deux boucles imbriquées :

- **interne, rapide, matérielle** : la Max AC ramène le compteur à zéro en quelques
  secondes, dans la limite de sa puissance (**3 540 W mesurés**, 3 600 W constructeur)
  et de son énergie ;
- **externe, lente, logicielle** : Domo alloue l'énergie **entre** batteries en
  agissant sur la seule consigne SB3.

Cette imbrication est structurante : **la Max AC masque nos erreurs au compteur.**
Un excédent de consigne SB3 n'apparaît pas en injection — il est absorbé par la
Max AC. Le compteur ne dit alors plus rien de notre erreur.

---

## 2. Règle 2 — démonstration de l'optimalité du prorata

**Énoncé.** _n_ batteries d'énergie utilisable _Eᵢ_ (réserve déduite). La maison
demande _P(t) > 0_, répartie en parts fixes _pᵢ = αᵢ·P_, _Σαᵢ = 1_. La batterie _i_
atteint sa réserve quand _αᵢ·W(Tᵢ) = Eᵢ_, avec _W(T) = ∫₀ᵀ P_.

L'autonomie du parc est _T\* = minᵢ Tᵢ_ : dès qu'une batterie touche sa réserve,
les autres doivent reprendre sa part — ou, si elles saturent, **on achète à EDF**
(violation de la règle 1). Maximiser _T\*_ revient à maximiser _minᵢ (Eᵢ/αᵢ)_.

**Preuve.** _(a)_ L'optimum égalise tous les rapports _Eᵢ/αᵢ_ : si _j_ réalise le
minimum et _Eₖ/αₖ > Eⱼ/αⱼ_, transférer _ε_ de _αₖ_ vers _αⱼ_ augmente strictement le
minimum pour _ε_ assez petit. Toute répartition non égalisatrice est donc
sous-optimale. _(b)_ Sous _Eᵢ/αᵢ = c_ et _Σαᵢ = 1_ (résolu en SymPy) :

> **αᵢ = Eᵢ / Σⱼ Eⱼ** et **W\* = Σⱼ Eⱼ**

Le parc délivre **la totalité** de son énergie utilisable avant que la première
batterie ne touche sa réserve, et toutes l'atteignent au même instant. ∎

**Vérification Monte Carlo** — 200 000 répartitions tirées au hasard (Dirichlet) :
aucune ne dépasse le prorata (meilleure : 8 922 Wh contre 8 942 Wh pour le prorata).

**Coût du bug du 28/07** — SB3 pleines (4 838 Wh utilisables) mais consigne 0,
Max AC à 67 % (4 104 Wh utilisables) :

| Répartition           | α(SB3) | Autonomie    | % du parc |
| --------------------- | ------ | ------------ | --------- |
| **prorata (règle 2)** | 0,541  | **8 942 Wh** | **100 %** |
| moitié-moitié         | 0,500  | 8 208 Wh     | 92 %      |
| consigne 0 (le bug)   | 0,000  | 4 104 Wh     | **46 %**  |

Le bug ne « perdait » pas un peu d'énergie : il **divisait l'autonomie par deux**.

---

## 3. Règle 3 — pourquoi la loi en service oscille

### 3.1 Le modèle

En régime dimensionnant (Max AC saturée, cas du cumulus à 3 kW), la boucle Domo
est le seul régulateur. La consigne écrite à l'instant _k_ n'agit qu'après _d_
périodes (écriture cloud → application device) :

> _g_k = C − u_{k−d}_ , \_u_{k+1} = u*k + K·g_k*
> ⟹ **_z^{d+1} − z^d + K = 0_**

### 3.2 Le résultat (SymPy)

| retard _d_ | _K_max_   | _ρ_ à _K = 1_                     |
| ---------- | --------- | --------------------------------- |
| 0          | 1,999     | 0,00 (deadbeat)                   |
| **1**      | **0,999** | **1,00 — oscillation entretenue** |
| 2          | 0,618     | 1,15 (divergent)                  |
| 3          | 0,445     | 1,18 (divergent)                  |

Pour _d = 1_ et _K > ¼_, les racines de _z² − z + K_ sont complexes conjuguées de
produit _K_ (Viète) : **|z| = √K**, d'où la condition **K < 1**. À _K = 1_ les racines
valent _e^{±iπ/3}_ : oscillation de **période 6 ticks = 2 minutes**, jamais amortie.

### 3.3 La confirmation par le journal réel

Journal de la boucle, 28/07, 25 minutes :

```
SOUTIRAGE 800 W → consigne 3xx → …
injection  786 W → consigne 1xx → …
SOUTIRAGE 814 W → consigne 3xx → …
```

Alternance de signe, amplitude constante, **36 écritures/heure = 864/jour**.
C'est le cycle limite prédit, à la période prédite. La loi que j'ai livrée
respecte la règle 3 sur le papier et la viole en pratique : une boucle qui
oscille ne converge jamais — c'est la pire des réactions différées.

---

## 4. Le remède : prédicteur de Smith

Le problème n'est pas le gain, c'est le **double comptage**. À l'instant _k_ le
compteur montre encore l'erreur que la correction précédente n'a pas eu le temps
de corriger ; en réagissant à nouveau, on commande deux fois la même chose.

**Correction** — on retranche de l'erreur mesurée les corrections déjà commandées
mais pas encore visibles :

> _e_k = g_k − Σ_{j=k−d+1}^{k} Δu*j* , _u_{k+1} = u*k + K·e_k*

Le retard sort de la boucle : la caractéristique redevient _z − 1 + K = 0_, stable
pour _0 < K < 2_, **deadbeat à K = 1**. On garde donc la correction **pleine et
immédiate** exigée par la règle 3, sans oscillation.

**Vérification** — échelon +1 200 W, Max AC saturée, retard 1 tick, bande morte 100 W :

| stratégie             | K       | achat Wh | injection Wh | écritures | erreur < 5 % après    |
| --------------------- | ------- | -------- | ------------ | --------- | --------------------- |
| **en service**        | 1,0     | 396,3    | 395,1        | 120       | 40 s _(puis oscille)_ |
| gain réduit           | 0,7     | 87,6     | 11,0         | 10        | 240 s                 |
| gain réduit           | 0,5     | 18,1     | 4,2          | 5         | 60 s                  |
| **Smith, gain plein** | **1,0** | **13,3** | **2,1**      | **1**     | **40 s**              |

Régime permanent (charge constante, seul le bruit du compteur excite la boucle) :

| stratégie             | écritures/jour |
| --------------------- | -------------- |
| en service            | 409            |
| gain 0,5              | 5              |
| **Smith, gain plein** | **1**          |

Le prédicteur de Smith est **strictement meilleur sur les quatre critères** :
il achète 30 fois moins, injecte 190 fois moins, écrit 120 fois moins, et
converge aussi vite que le réglage le plus agressif.

---

## 5. Un défaut de mesure : le flux de la Max AC n'est pas signé

La boucle lit `ac_grid_output_power` (registre Modbus **10208**) comme flux net de
la Max AC. **Vérifié sur l'appareil** — pendant que la batterie charge à 2 050 W :

```
statut = charging   10008/10009 = −2050 W   10208/10209 = 0 W
```

Sur **18 148 échantillons** de `history.db`, ce champ n'est **jamais** négatif :
c'est une puissance de **sortie seule**. Conséquences :

- la charge maison calculée est fausse dès que la Max AC absorbe ;
- le partage au prorata se calcule sur un total tronqué ;
- surtout, **le transfert batterie→batterie est invisible**.

Le registre **10008/10009 (`battery_power`) est signé** — c'est celui qu'il faut
utiliser (déjà lu par Domo sous le nom `battery_power_w`, mais non exploité par
la boucle).

**Ampleur mesurée du recyclage** (30 jours, proxy conservateur : SB3 déchargent
au-delà de leur PV **et** Max AC ne sort rien **et** compteur à l'équilibre) :

> **jusqu'à 2,13 kWh/jour**, 23 % du temps, 381 W en moyenne quand actif
> — soit ≈ **0,21 kWh/jour de pertes de conversion** (η aller-retour 0,90), ≈ 78 kWh/an.

---

## 6. Ce qu'une prédiction ratée a appris

Ma simulation prédisait que la loi en service **écrête 8,6 kWh/jour de PV** des SB3
en abaissant leur consigne sous leur propre production. **Test sur données réelles**
(30 jours, PV > 100 W, par tranche de SoC) :

| SoC          | n         | médiane(sortie − PV) | sortie ≥ 0,9·PV |
| ------------ | --------- | -------------------- | --------------- |
| 0–60 %       | 2 135     | −471 W               | 7,7 %           |
| 60–85 %      | 1 997     | −568 W               | 20,6 %          |
| 85–95 %      | 2 597     | −6 W                 | 81,1 %          |
| **99–101 %** | **1 253** | **−2 W**             | **87,2 %**      |

**Prédiction réfutée.** Quand les packs sont pleins, le firmware passe le PV en AC
de lui-même : la consigne ne l'écrête pas. Le gain de 2,8 kWh annoncé par le modèle
était un artefact. Le modèle a été corrigé ; la conclusion n'a pas été gardée.

---

## 7. Plan de mise en œuvre

| #     | Changement                                                                       | Justification                                                                     | Risque                                                            |
| ----- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **1** | **Prédicteur de Smith** sur l'erreur compteur, gain plein K = 1                  | §3–4 : supprime le cycle limite mesuré (864 écr./j → ~1–30), −30× sur l'achat EDF | faible : dégrade au pire vers la loi actuelle si la file est vide |
| **2** | Flux Max AC lu sur **`battery_power` (signé)** au lieu de `ac_grid_output_power` | §5 : défaut de mesure vérifié sur l'appareil                                      | faible, corrige une erreur certaine                               |
| **3** | Terme **anti-recyclage** borné à la part batterie                                | §5 : jusqu'à 2,13 kWh/j de transfert inutile                                      | moyen — à observer avant de durcir                                |
| **4** | Bande morte **large** sur les chemins non urgents, serrée sur l'erreur compteur  | la règle 1 est urgente, le partage ne l'est pas                                   | faible                                                            |
| **5** | Prorata pack par pack (déjà en place)                                            | §2 : démontré optimal                                                             | néant                                                             |

**Non retenu** : baisser le gain (le prédicteur fait mieux sur tous les critères),
et le plancher PV (réfuté au §6 — le firmware s'en charge).

**Ordre** : 1 et 2 d'abord (correctifs de justesse, effet mesurable immédiat),
observation, puis 3 et 4.

---

## 8. La capacité de puissance, et ce qu'il reste d'irréductible

_Ajouté le 30/07 après une précision de Laurent : avant l'achat de la Max AC, la
puissance de sortie du parc ne couvrait pas les fortes demandes (cumulus 2,9 kW +
talon + usage domestique), d'où des compléments EDF. Vérification._

**Mise en service de la Max AC : 22/07/2026 19:16** (première trace dans `history.db`).
Puissance simultanée observée depuis : **5 608 W** batteries seules, **6 125 W** avec
l'APS — cohérent avec les ~5 900 W annoncés par Laurent.

**Achat EDF pendant que le cumulus chauffe**, mesuré au compteur EM-50 :

| période          | durée  | chauffe   | achat pendant chauffe | par jour  |
| ---------------- | ------ | --------- | --------------------- | --------- |
| **avant** Max AC | 39,1 j | 111,1 kWh | 4 906 Wh (**4,42 %**) | 125 Wh    |
| **après** Max AC | 7,5 j  | 16,7 kWh  | 177 Wh (**1,06 %**)   | **24 Wh** |

**Facteur 5 par jour.** L'explication de Laurent est validée : c'était une limite de
PUISSANCE, pas un défaut de régulation. Mon constat antérieur (« la règle zéro achat est
déjà enfreinte, 2,9 kWh sur 30 jours ») portait sur une fenêtre dont 80 % précède la
Max AC — il était juste mais trompeur.

### D'où vient le résidu de 1 % ?

Les 46 instants de soutirage en chauffe depuis la Max AC ont tous lieu **de jour**
(10 h–15 h), parc à **90 % de SoC médian** — donc pas un parc vide. Et surtout :

- **Max AC à sa butée (3 510–3 530 W) dans 89 % des cas** ;
- **SB3 à 1 341 W médian, jamais au-delà de 1 851 W** — soit ~1 000 W de réserve inutilisée
  sous leur plafond de 2 400 W.

Ce qui ressemble à une faute de pilotage n'en est pas une. Le détail des épisodes le
montre :

```
15:12:33   cumulus 2988   réseau  −50   SB3 1277   MaxAC 2060
15:13:08   cumulus 2952   réseau +1451  SB3 1277   MaxAC 3510   ← échelon ~1,5 kW
15:14:48   cumulus 2985   réseau   +14  SB3 1264   MaxAC 1560   ← résorbé
```

Un **échelon de charge de 1,5 à 2,8 kW** apparaît, la Max AC monte à sa butée en quelques
secondes (elle est locale), le réseau comble la différence pendant ~30 à 60 s, puis tout
rentre dans l'ordre. **Les SB3 ne bougent pas** — et elles ne peuvent pas : leur commande
passe par le **cloud Anker**, soit un tick de 20 s plus l'aller-retour. L'événement est
terminé avant qu'elles aient pu répondre.

### Conséquence pour la règle 1

Le résidu n'est pas réductible par la loi de commande. Il est fixé par la chaîne
d'actionnement :

- la seule batterie assez rapide pour un transitoire est la **Max AC**, et elle atteint
  déjà sa butée ;
- les SB3 ont la réserve de puissance, mais pas la réactivité.

Les deux seules voies pour aller plus loin, par ordre de valeur :

1. **une commande LOCALE des SB3** (Modbus ou MQTT) — supprimerait le retard cloud ;
   vérifié le 29/07 : les tunnels 1502/1503 ne desservent que le compteur Gen 2 et la
   Max AC, les SB3 ne sont pas exposées. À chercher côté firmware SB3.
2. **anticiper l'échelon connu** : le seul échelon de 2,9 kW prévisible est le cumulus
   lui-même, puisque c'est NOUS qui l'allumons. Monter la consigne SB3 _avant_ de fermer
   le relais supprimerait le transitoire à la source — sans rien deviner, puisque
   l'instant est choisi.

La seconde est gratuite et sûre : elle n'ajoute aucune prédiction météo ni aucun seuil,
seulement l'ordre correct de deux actions que l'on commande déjà.

---

## 9. La recharge du parc — étude 31/07, et pourquoi la loi n'a PAS été écrite

### 9.1 Le constat de départ

Le parc DIVERGE : le 30/07, SB3 à 95 % et 81 %, Max AC à 17 %. En régime de surplus
(45 % de la journée), le PV DC des SB3 valait 1 105 W médian, leur sortie AC **0 W**,
donc **877 W restaient dans des packs déjà quasi pleins** pendant que la Max AC vide
n'avait aucun accès au bus AC. Rapport sortie/PV : médiane **0,00**.

Verrou identifié à la ligne près — `decide.ts:185` :

```
battTotalW = max(0, sb3Out + maxac.acNetW)
```

En surplus `acNetW` est négatif (la Max AC charge), la somme passe sous zéro, `max(0,·)`
la ramène à 0, et la cible devient `part × 0 = 0`. **La correction du flux signé, juste
en elle-même, a resserré ce verrou** : avant, `acNetW` non signé valait 0 en charge et
`battTotal` valait au moins `sb3Out`.

### 9.2 Le rendement du routage est inobservable — et ça n'a pas d'importance

Ni mesurable : la charge de la Max AC n'est pas enregistrée (**0 valeur négative sur
22 600 échantillons** — registre 10208, sortie seule), et le stock est quantifié à
**16 Wh** quand 1 000 W pendant 33 s n'en font que 9,2.

Ni nécessaire : le chemin routé compte **deux conversions** contre **une** pour le
direct, donc `η_r < η_d` avec certitude. Or

> ∂E/∂x_direct − ∂E/∂x_routé = η_d − η_r > 0

ne dépend que du **signe**. L'ordre de mérite — remplir le direct, déverser ensuite —
est donc optimal pour **toute** valeur du rendement inconnu.

### 9.3 …mais la prémisse s'effondre à la mesure

L'ordre de mérite suppose qu'on **peut** déverser vers la Max AC. Sur les 1 017 instants
d'injection > 300 W avec place disponible (8,6 jours depuis la Max AC) :

| grandeur                        | médiane                                                 |
| ------------------------------- | ------------------------------------------------------- |
| PV DC des SB3                   | 1 582 W                                                 |
| sortie AC des SB3               | 1 563 W (**≥ 0,9·PV dans 90 % des cas → packs pleins**) |
| APS                             | 48 W (bridé par la boucle anti-injection)               |
| bus AC fourni                   | 1 630 W                                                 |
| injection                       | **931 W**                                               |
| **charge déduite de la Max AC** | **99 W** — < 1 000 W dans 97 % des cas, max 2 112 W     |

**La Max AC n'est ni pleine ni à un plafond de puissance : elle n'absorbe pas.**
Déverser davantage vers le bus AC ne ferait donc qu'injecter davantage.

Hypothèses écartées par la mesure : désaccord des compteurs (Gen 2 vs EM-50, écart
mesuré 4 à 39 W — ils concordent) ; plafond de charge (0 % des instants au-dessus de
2 000 W).

### 9.4 Ce qui reste incertain, honnêtement

La « place » est déduite de `batt_energy_wh` (cloud), qui **gèle** : médiane 5,4 min
entre deux changements, p90 15,8 min, **maximum 2,6 h**, avec des sauts jusqu'à
15 points. Le chiffre de **11,37 kWh récupérables sur 8,6 jours (1 317 Wh/jour,
≈ 96 €/an)** porte cette incertitude. Il a d'ailleurs déjà été corrigé une fois : ma
première estimation de 2 022 Wh/jour comptait la tolérance de régulation zéro-export
(injection médiane 34 W, p90 62 W), qui n'est pas récupérable.

### 9.5 Décision

**La loi de recharge n'est pas écrite**, et ce n'est pas un renoncement : écrire une loi
de déversement alors que le puits n'absorbe pas produirait exactement l'effet inverse de
celui recherché. La question à trancher d'abord est **matérielle, pas logicielle** :
pourquoi la Max AC n'absorbe-t-elle pas le surplus du bus AC ?

Et l'arbitrage entre les deux lectures de la règle 2 (prorata de la place, qui égalise
les SoC, contre ordre de mérite, qui minimise les pertes) ne vaut de toute façon que
**14 à 40 Wh/jour** — contre **~2 000 Wh/jour** pour la question « déverser ou non ».

### 9.6 Défaut collatéral vérifié : le prédicteur de Smith est INERTE

Sa fenêtre `enVolS` vaut **20 s**, la période réelle du tick **23,2 s** (médiane, min 20,
max 25) : **100 % des ticks dépassent la fenêtre**, la file des corrections en vol est
purgée avant d'être lue. Le prédicteur ne retranche jamais rien.

La chute du taux d'écriture (864 → 118/jour) est donc à mettre au crédit de la **borne de
marge de la Max AC** et de l'**approche progressive du partage**, pas du prédicteur.
Correction dérivable : la fenêtre doit survivre à exactement un tick, donc être comprise
entre T et 2T, soit **30 s** (à 45 s elle survivait deux ticks et sur-corrigeait —
mesuré : 137 → 2 146 → 0 W). Non appliqué : le système est stable, rallumer un
prédicteur resté inerte demande un test dédié.
