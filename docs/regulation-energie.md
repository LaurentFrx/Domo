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

| Élément                       | Rôle                    | Commandable ?                                     | Mesure                               |
| ----------------------------- | ----------------------- | ------------------------------------------------- | ------------------------------------ |
| **2 × Solarbank 3 E2700 Pro** | 2 × 2 688 Wh, PV propre | consigne AC 0–2 400 W, **via le cloud Anker**     | SoC + sortie (cloud, retard 1–3 min) |
| **Solarbank Max AC**          | 7 200 Wh                | **non** — asservit le compteur à zéro toute seule | Modbus **local**, ~2 s               |
| **Onduleur APS EZ1**          | PV AC, 0–960 W          | plafond, **local**                                | local, ~10 s                         |
| **Compteur Shelly EM-50**     | réseau signé            | —                                                 | **local, instantané**                |

Deux boucles imbriquées :

- **interne, rapide, matérielle** : la Max AC ramène le compteur à zéro en quelques
  secondes, dans la limite de sa puissance (~2 000 W) et de son énergie ;
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
