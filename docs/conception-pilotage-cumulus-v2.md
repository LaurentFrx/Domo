# Le pilotage automatique du chauffe-eau — proposition à valider

> **Statut : simple proposition.** Rien de ce qui est décrit ici n'est en service.
> Depuis le 2 juillet 2026, le chauffe-eau est repassé en commande entièrement
> manuelle, et il y restera tant que ce document n'aura pas été relu, corrigé et
> approuvé par Laurent.

---

## Pourquoi ce document

La première version du pilotage automatique a échoué. Elle raisonnait comme un
comptable : elle acceptait d'acheter du courant à EDF pendant une chauffe dès lors
que ce courant revenait moins cher que celui des heures creuses. Résultat : quatre
cents à six cents watts achetés en continu à EDF en plein été, pendant que le soleil
donnait à plein. C'est exactement ce que le pilotage manuel ne faisait jamais.

Cette nouvelle version repose sur un principe unique, sans exception économique :

> **Le chauffe-eau ne doit jamais être la cause d'un achat de courant à EDF.**
>
> On l'allume uniquement quand la maison est en train de donner gratuitement de
> l'électricité au réseau (puisqu'elle n'est pas payée pour cela, cette électricité
> est perdue). On l'éteint dès que la maison a besoin de sa puissance pour autre
> chose. Autrement dit : le système doit reproduire le geste que vous faites à la
> main, ni plus, ni moins.

Il n'existe que deux moments où le système acceptera, en toute connaissance de
cause, de prendre un peu de courant à EDF :

1. **Les toutes premières minutes d'une chauffe.** Quand le chauffe-eau s'allume,
   les deux stations solaires Anker mettent deux à trois minutes à comprendre que
   la maison réclame de la puissance et à monter leur débit. Pendant ce court
   délai, le courant vient du réseau. C'est une réalité physique de votre
   installation : elle se produit exactement de la même façon quand vous allumez le
   chauffe-eau à la main. Cela représente environ cent wattheures par allumage,
   soit à peu près deux centimes d'euro.

2. **La recharge de fin de nuit**, pendant les heures creuses, quand le soleil de la
   veille n'a pas suffi. C'est un choix assumé : le courant y est au tarif le plus
   bas, et l'eau finit de chauffer juste avant les douches du matin.

---

## Première partie — Ce que le système voit, et à quelle vitesse

Pour décider, le système dispose de plusieurs sources d'information. Elles n'ont
pas toutes la même rapidité ni la même fiabilité, et c'est une des leçons de
l'échec précédent : il faut savoir laquelle croire, et quand.

**Le compteur principal** (le boîtier Shelly installé dans le tableau électrique)
est la seule source instantanée et digne de confiance. Il répond en une fraction de
seconde et mesure deux choses : d'une part **l'échange avec le réseau EDF** — la
maison est-elle en train d'acheter du courant, ou d'en donner gratuitement au
réseau ? — et d'autre part **la consommation du chauffe-eau lui-même**, ce qui
permet notamment de détecter l'instant précis où son thermostat mécanique coupe la
résistance, c'est-à-dire l'instant où le ballon est plein.

> Toute décision d'allumer ou d'éteindre s'appuiera sur ce compteur, et sur lui
> seul. C'est la règle qui découle de l'échec précédent.

**Les deux stations solaires Anker** (les batteries) donnent leurs informations par
Internet, avec **environ une minute de retard**. On y lit le niveau de remplissage
des batteries, la puissance avec laquelle elles se chargent ou se déchargent, et la
production des panneaux qui leur sont raccordés. Ce retard d'une minute interdit de
s'en servir pour des décisions instantanées ; en revanche, ces informations
conviennent très bien pour des conditions qui évoluent lentement, comme « les
batteries sont-elles pleines ? ».

Il faut signaler un piège important, découvert le 2 juillet : **quand les batteries
sont pleines, la production solaire affichée par les stations Anker devient
mensongère.** Les stations réduisent alors volontairement leur production au strict
niveau de la demande de la maison — c'est ce qu'on appelle le bridage. Les panneaux
pourraient produire deux mille cinq cents watts, mais l'affichage n'en montre que
cent, parce que la maison n'en demande pas plus. La première version du pilotage
s'est fait piéger : elle attendait de « voir » une grande production avant
d'allumer, production qui ne pouvait précisément plus se voir. Le surplus était là,
invisible, et partait au réseau en pure perte.

**Le petit onduleur APsystems** (les deux panneaux du pan Sud qui injectent
directement, sans batterie) est lu localement toutes les dix secondes. Il produit
toujours son maximum ; ce qui n'est pas consommé par la maison part au réseau.

**La sonde de température du ballon**, complétée par les thermomètres de la maison,
alimente le calcul de **la réserve d'eau chaude**, exprimée en « nombre de douches
disponibles ». Ce calcul, mis au point et vérifié ces dernières semaines, est
conservé tel quel : il s'est montré fiable. Il permet aussi de savoir chaque soir
s'il manquera de l'eau chaude pour les deux douches du matin, vers sept heures
trente.

**Les prises connectées du lave-vaisselle et du lave-linge** signalent quand un de
ces appareils tourne. Le four, les plaques et la bouilloire ne sont pas mesurés
individuellement, mais ce n'est pas un problème : dès qu'ils tirent du courant, le
compteur principal le voit immédiatement dans l'échange avec le réseau.

**La prévision météorologique** (Météo-France) ne servira plus jamais à déclencher
une chauffe — l'échec précédent a montré qu'une annonce de beau temps ne dit rien
du surplus réellement disponible à un instant donné. Elle ne sert plus qu'à une
chose : décider, la nuit, s'il est raisonnable de compter sur le soleil du
lendemain ou s'il faut recharger en heures creuses.

Enfin, le système garde en mémoire son propre état : le chauffe-eau est-il allumé
et depuis quand, combien d'allumages ont déjà eu lieu aujourd'hui, le thermostat
a-t-il coupé, et les délais de protection du matériel sont-ils écoulés (un
contacteur ne doit pas claquer toutes les cinq minutes).

### Les trois réalités physiques qui commandent tout le reste

Les mesures faites le 2 juillet, pendant les essais, ont établi trois faits :

1. **Les stations Anker mettent deux à trois minutes à réagir** quand une grosse
   consommation démarre. Il faut donc accorder un délai de grâce à chaque allumage,
   et ne pas juger une chauffe sur ses premières minutes.
2. **Après un choc (allumage ou coupure), leur régulation oscille pendant deux à
   quatre minutes** : leur débit peut retomber à zéro puis remonter à pleine
   puissance sans raison apparente. Conclusion : ne jamais prendre de décision sur
   une mesure isolée ; exiger qu'une situation persiste avant d'agir.
3. **Chaque allumage et chaque coupure ont un coût caché** (le délai de réaction,
   l'oscillation, l'usure du contacteur). Conclusion : allumer rarement, aux
   moments les plus sûrs, et tenir longtemps — plutôt qu'essayer souvent.

---

## Deuxième partie — Comment le système raisonne : les phases

Le pilotage fonctionne comme une suite de phases clairement nommées, chacune avec
sa règle propre. À tout moment, le système est dans une et une seule de ces phases.

**Le repos.** Le chauffe-eau est éteint. Le système surveille en permanence les
sept conditions d'allumage décrites plus bas. Quand elles sont toutes réunies, il
ne se précipite pas : il attend qu'elles **restent** réunies pendant cinq minutes
d'affilée. Une embellie de trente secondes entre deux nuages ne déclenche rien.

**L'allumage** (les quatre premières minutes d'une chauffe). Le contacteur vient de
se fermer, la résistance chauffe, et les stations Anker n'ont pas encore réagi :
pendant deux à trois minutes, le courant vient du réseau — c'est le passage obligé
décrit plus haut. Le système surveille sans juger. Si au bout de quatre minutes le
courant continue de venir du réseau au lieu du soleil (par exemple parce qu'un
grand nuage est arrivé pile à ce moment), il renonce et coupe.

**La chauffe établie.** C'est le régime de croisière, et c'est ici que s'applique
la règle d'or dans toute sa rigueur :

- Si la maison se met à acheter plus de **cent cinquante watts** au réseau, et que
  cela dure plus d'**une minute et demie**, le système coupe le chauffe-eau,
  immédiatement et sans état d'âme. La maison a besoin de sa puissance — four,
  plaques, bouilloire, lave-vaisselle, peu importe — elle passe avant le ballon.
  Le délai d'une minute et demie sert uniquement à ne pas confondre un vrai besoin
  avec une des oscillations passagères des stations Anker.
- Un passage nuageux ordinaire ne coupe rien : les batteries, qui sont pleines,
  prennent le relais des panneaux, et la maison n'achète rien au réseau. C'est le
  comportement voulu.
- En revanche, si le mauvais temps s'installe, les batteries se vident peu à peu
  pour nourrir le ballon — et cela, le compteur ne le voit pas, puisque rien n'est
  acheté au réseau. C'est pourquoi une seconde protection veille : si **le niveau
  des batteries a baissé de cinq points** depuis le début de la chauffe, le système
  coupe. Vos batteries sont la réserve de la soirée ; le ballon n'a pas le droit de
  les vider.
- La fin normale d'une chauffe, c'est le **thermostat mécanique du ballon** qui la
  décide, comme toujours : quand l'eau atteint sa température, il coupe la
  résistance de lui-même. Le système le détecte (la consommation du chauffe-eau
  tombe à presque rien alors que le contacteur est fermé), en conclut que le ballon
  est plein, et remet sa jauge de réserve d'eau chaude à son maximum.

**La cession.** C'est la phase où arrive le système quand il a coupé pour laisser
la puissance à la maison. Il y reste le temps que les protections du matériel
imposent (au moins cinq minutes éteint, et au moins dix minutes entre deux
manœuvres), puis retourne au repos, où il attendra de nouveau que les sept
conditions soient réunies cinq minutes durant.

**Le plein.** Le thermostat a coupé : il n'y a plus rien à faire jusqu'à ce que de
l'eau chaude soit utilisée. Quand une douche fait baisser la température du ballon
de quelques degrés, le système retourne au repos.

**La recharge de fin de nuit** (le garde-fou). Indépendamment de tout ce qui
précède, le système calcule chaque soir ce qui manquera pour assurer deux douches
à sept heures trente, en tenant compte du refroidissement naturel du ballon pendant
la nuit. S'il manque quelque chose, il programme une chauffe en heures creuses,
calée pour se **terminer** vers sept heures et quart : commencer plus tôt ne ferait
que payer des pertes de chaleur inutiles. Cette chauffe s'arrête dès que le
nécessaire est atteint — pas besoin de remplir le ballon à ras bord à l'aube quand
le soleil s'en chargera gratuitement trois heures plus tard. Les batteries, elles,
ne sont **jamais** mises à contribution la nuit pour le ballon.

**Vos commandes, toujours prioritaires.** Le mode **Manuel** vous rend
l'interrupteur : le système n'y touche plus. Le mode **Vacances** coupe tout. Le
bouton **« Chauffer maintenant »** lance une chauffe immédiate jusqu'au plein, quel
que soit le prix du courant à cet instant — c'est votre choix, le système
l'exécute sans discuter. Et dans tous les cas, les protections de fond demeurent :
coupure de sécurité si l'eau dépasse soixante-dix degrés, délais anti-usure du
contacteur, et coupure automatique du boîtier Shelly si jamais le système
informatique cessait de répondre.

---

## Troisième partie — Les sept conditions pour allumer au soleil

Le système n'allume la chauffe solaire que si les sept conditions suivantes sont
**toutes** vraies, **en même temps**, et le restent **pendant cinq minutes**.

1. **Le ballon n'est pas déjà plein.** Sa réserve est en dessous de quatre-vingt-
   quinze pour cent, et le thermostat n'a pas coupé récemment.

2. **La maison donne du courant au réseau, franchement et durablement.** Le
   compteur principal mesure plus de **trois cents watts** qui partent vers EDF, en
   continu depuis cinq minutes. C'est la preuve directe, indiscutable, que de
   l'énergie est en train d'être perdue — puisqu'elle n'est pas payée. C'est le
   signal de référence.

3. **Les batteries sont pleines.** Leur niveau dépasse quatre-vingt-dix-sept pour
   cent et elles n'absorbent presque plus rien. Tant qu'elles se remplissent, le
   surplus a une meilleure destination que le ballon : on ne leur vole jamais leur
   recharge.

4. **La maison est tranquille.** Ni le lave-vaisselle ni le lave-linge ne tournent
   (leurs prises connectées font foi). Quant au four ou aux plaques, s'ils étaient
   allumés, la maison ne serait pas en train de donner du courant au réseau — la
   condition numéro deux les couvre donc naturellement.

5. **Il reste des heures de soleil devant soi.** L'allumage n'est autorisé
   qu'entre dix heures trente et seize heures trente. Une chauffe lancée en fin
   d'après-midi finirait inévitablement sur les batteries, au détriment de la
   soirée.

6. **Le quota du jour n'est pas épuisé.** Deux allumages solaires par jour, pas
   davantage. Multiplier les essais, c'est secouer la régulation des stations Anker
   et user le contacteur — l'échec du 2 juillet l'a démontré.

7. **Les délais de protection du matériel sont écoulés** (cinq minutes minimum
   depuis la dernière coupure, dix minutes entre deux manœuvres).

### Le cas particulier du surplus invisible

Il existe une situation, observée le 2 juillet, où du surplus se perd **sans**
que le compteur montre un don franc au réseau : les batteries sont pleines, les
stations Anker ont bridé leurs panneaux, et l'échange avec le réseau reste proche
de zéro. Les panneaux pourraient produire deux mille watts de plus ; rien ne le
montre. Pour ce cas, la proposition est un déclencheur de secours : si les
batteries sont pleines, qu'elles n'absorbent plus rien, qu'il fait grand jour et
que la maison n'achète rien au réseau — le tout pendant cinq minutes — alors
l'allumage est permis lui aussi. Toutes les autres conditions (maison tranquille,
fenêtre horaire, quota, délais) restent exigées. C'est la **question numéro deux**
posée à la fin de ce document.

---

## Quatrième partie — Douze journées racontées

**1. Une belle journée d'été, maison tranquille.** Les batteries atteignent cent
pour cent vers onze heures. La maison se met à donner plusieurs centaines de watts
au réseau. Au bout de cinq minutes de ce régime, le chauffe-eau s'allume. Les
stations Anker mettent leurs deux ou trois minutes à monter, puis la chauffe se
poursuit entièrement au soleil, jusqu'à ce que le thermostat coupe, vers treize ou
quatorze heures. Le seul courant acheté à EDF aura été celui du délai de réaction
initial — environ deux centimes. C'est très exactement votre journée type en
pilotage manuel.

**2. Le lave-vaisselle démarre pendant la chauffe.** Il tire deux mille watts ; les
stations, déjà à pleine puissance pour le ballon, ne peuvent pas suivre ; la maison
se met à acheter au réseau. Au bout d'une minute et demie, le système coupe le
chauffe-eau : la vaisselle passe d'abord. Une fois le cycle terminé, si le don au
réseau reprend franchement pendant cinq minutes, le système utilise son deuxième et
dernier allumage de la journée pour finir le ballon.

**3. Des nuages qui vont et viennent.** Pendant la chauffe, chaque passage nuageux
fait chuter les panneaux, mais les batteries pleines prennent le relais : la maison
n'achète rien, le système ne coupe pas. Si le ciel se couvre durablement, les
batteries s'entament ; dès qu'elles ont perdu cinq points, le système coupe
proprement et rend la main. Fini les allumages-coupures en cascade de la première
version.

**4. Une journée entièrement grise.** Le don franc au réseau ne se produit jamais ;
le chauffe-eau reste éteint toute la journée. Le soir, le système constate qu'il
manquera de l'eau pour les douches du matin et programme la recharge de fin de
nuit, au tarif le plus bas, calée pour finir vers sept heures et quart. Les douches
sont garanties.

**5. Le matin, batteries à moitié.** Tout le surplus solaire va dans les batteries ;
rien n'est perdu ; le chauffe-eau ne s'allume pas. Il attendra qu'elles soient
pleines.

**6. Dix-sept heures trente, grand soleil, don franc au réseau.** La fenêtre
horaire est passée : pas d'allumage. Une chauffe commencée si tard finirait sur les
batteries, au détriment de la soirée. Ce surplus de fin de journée est perdu —
comme il l'était en pilotage manuel. (Voir la **question numéro trois** : faut-il
élargir la fenêtre en plein été ?)

**7. Des invités prennent des douches à vingt heures.** La réserve d'eau chaude
chute. Le système ne fait rien la nuit (les batteries sont intouchables), mais la
recharge de fin de nuit couvrira le manque avant le matin. Si la réserve tombait en
dessous d'une seule douche, la **question numéro un** (ci-dessous) décidera du
comportement.

**8. Le repas de midi se prépare pendant une chauffe.** Four et plaques s'allument ;
la maison achète au réseau ; en une minute et demie, le chauffe-eau s'efface.
Toute la puissance revient à la cuisine.

**9. Le ballon est plein à treize heures trente.** Le thermostat coupe de lui-même,
le système l'enregistre, tout s'arrête. Le surplus repart au réseau : la mission du
jour est accomplie, le ballon est plein.

**10. Vous pilotez à la main.** Le mode Manuel est prioritaire sur tout. Le système
se contente d'observer et de tenir le journal ; il ne touche à rien.

**11. En hiver.** Les batteries n'atteignent que rarement le plein ; les conditions
d'allumage solaire sont donc rarement réunies, et c'est la recharge de fin de nuit
qui porte l'essentiel — avec des besoins d'eau chaude recalculés pour la saison
(l'eau froide arrive à neuf degrés au lieu de quinze). Les beaux jours d'hiver, la
chauffe solaire reprend ses droits.

**12. Le surplus invisible.** Batteries pleines, panneaux bridés, échange avec le
réseau proche de zéro : selon la réponse à la question numéro deux, le déclencheur
de secours capte cette énergie perdue, ou bien on choisit de la laisser filer par
prudence.

---

## Cinquième partie — Et si quelque chose tombe en panne ?

- **Le compteur principal ne répond plus** : plus aucune chauffe solaire (la seule
  source de vérité manque). Seule la recharge de fin de nuit reste active.
- **Les stations Anker ne répondent plus** : l'allumage sur don franc au réseau
  reste possible (il ne dépend que du compteur principal), mais la protection du
  niveau des batteries devient aveugle ; en compensation, la fenêtre horaire se
  resserre (fin à quinze heures).
- **La sonde du ballon se tait** : la jauge de réserve dérive lentement ; au-delà
  de deux jours sans nouvelles, plus de chauffe solaire, et une recharge de nuit
  prudente.
- **Le boîtier du contacteur ne répond plus** : aucun ordre n'est envoyé, et la
  carte affiche l'anomalie.

Dans le pire des cas imaginable, le système dégénère toujours vers le même
comportement : « une recharge en heures creuses qui se termine à sept heures et
quart » — c'est-à-dire un chauffe-eau ordinaire bien réglé. Il n'existe aucun
scénario de panne où les douches du matin sont menacées ou la facture aggravée.

---

## Sixième partie — Les valeurs proposées (toutes modifiables)

| Ce que la valeur règle                         | Proposition                                                     |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Don au réseau considéré comme franc            | plus de trois cents watts                                       |
| Durée d'observation avant d'allumer            | cinq minutes                                                    |
| Batteries considérées comme pleines            | niveau au-dessus de quatre-vingt-dix-sept pour cent             |
| Fenêtre d'allumage solaire                     | de dix heures trente à seize heures trente                      |
| Nombre maximal d'allumages solaires par jour   | deux                                                            |
| Délai de grâce au démarrage                    | quatre minutes                                                  |
| Achat au réseau qui déclenche la coupure       | plus de cent cinquante watts pendant plus d'une minute et demie |
| Baisse des batteries qui déclenche la coupure  | cinq points depuis le début de la chauffe                       |
| Heure visée pour la fin de la recharge de nuit | sept heures et quart                                            |

---

## Septième partie — Les cinq questions qui vous appartiennent

1. **S'il ne reste plus qu'une seule douche en réserve, un après-midi gris**, que
   doit faire le système : chauffer immédiatement au tarif plein (l'eau chaude est
   garantie, pour environ soixante centimes), ou attendre les heures creuses de la
   nuit (au risque qu'une douche du soir soit froide) ?

2. **Le surplus invisible** (batteries pleines, panneaux bridés, rien d'apparent au
   compteur) : faut-il activer le déclencheur de secours décrit plus haut pour
   capter cette énergie perdue ? Je le recommande — il est entouré des mêmes
   garde-fous que le déclencheur principal.

3. **La fenêtre d'allumage** (dix heures trente à seize heures trente) vous
   convient-elle ? Vos panneaux orientés à l'ouest produisent tard en plein été :
   on peut prolonger jusqu'à dix-sept heures en juillet-août.

4. **Deux allumages solaires par jour au maximum** : est-ce fidèle à votre façon de
   faire ?

5. **Les seuils** — trois cents watts pendant cinq minutes pour allumer, cent
   cinquante watts pendant une minute et demie pour couper : ces valeurs
   correspondent-elles à votre expérience de l'installation ?

---

_Document soumis à la relecture et à l'annotation de Laurent. Aucune ligne de code
ne sera écrite avant son accord. Le chauffe-eau reste en commande manuelle._
