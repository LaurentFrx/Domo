# -*- coding: utf-8 -*-
"""
TRAITEMENT DU RETARD PUR — trois stratégies comparées.

Symptôme mesuré en service (28/07, 25 min de journal) : alternance
soutirage 800 W → injection 786 W → soutirage 814 W, 36 écritures/heure,
soit 864/jour. Signature d'un cycle limite.

Théorie (SymPy) : pour u_{k+1} = u_k + K·g_k avec g_k = C − u_{k−d},
l'équation caractéristique est z^{d+1} − z^d + K = 0. À d=1, K=1 :
racines e^{±iπ/3}, module 1 → oscillation ENTRETENUE de période 6 ticks
= 2 min. C'est exactement ce qu'on observe.

Trois remèdes :
  1. baisser le gain              K < 1  (amortit, mais couvre moins vite)
  2. PRÉDICTEUR DE SMITH          on retranche de l'erreur mesurée les
     corrections DÉJÀ COMMANDÉES mais pas encore visibles. Le retard sort
     de la boucle : on peut garder K = 1 (réponse complète en un coup)
     sans osciller. C'est la réponse propre au retard pur.
  3. les deux
"""
import numpy as np
Ts, U_MAX, SIGMA = 20.0, 2400.0, 17.0

def essai(K, smith, d=1, n=180, ech=1200.0, maxac_max=0.0, seed=0):
    """Échelon de charge `ech` à k=0, Max AC saturée (pire cas)."""
    rng = np.random.default_rng(seed)
    u = np.zeros(n + d + 2)
    dep = []                       # corrections en vol
    achat = inj = 0.0; ecr = 0; t95 = None
    for k in range(n):
        g_vrai = ech - u[max(0, k - d)]
        g = g_vrai + rng.normal(0, SIGMA)
        achat += max(0.0, g_vrai) * Ts / 3600.0
        inj += max(0.0, -g_vrai) * Ts / 3600.0
        if t95 is None and abs(g_vrai) < 0.05 * ech: t95 = k
        # Smith : l'erreur mesurée ignore les corrections pas encore appliquées
        en_vol = sum(dep[-d:]) if (smith and d > 0) else 0.0
        e = g - en_vol
        cible = float(np.clip(u[k] + K * e, 0.0, U_MAX))
        delta = cible - u[k]
        if abs(delta) > 100.0:
            u[k+1] = cible; ecr += 1; dep.append(delta)
        else:
            u[k+1] = u[k]; dep.append(0.0)
    return achat, inj, ecr, t95

print("=" * 88)
print("ÉCHELON +1200 W, Max AC saturée, retard d = 1 tick (20 s), bande morte 100 W")
print("=" * 88)
print("  stratégie                 K     achat Wh  inject Wh  écritures  |g|<5%% après")
for lbl, K, sm in [("service actuel",      1.0, False),
                   ("gain réduit",         0.7, False),
                   ("gain réduit",         0.5, False),
                   ("Smith + gain plein",  1.0, True),
                   ("Smith + gain 0,8",    0.8, True)]:
    a, i, e, t = essai(K, sm)
    print("  %-22s %.1f  %9.2f %10.2f %10d   %s"
          % (lbl, K, a, i, e, ("%d ticks (%ds)" % (t, t*Ts)) if t is not None else "JAMAIS"))

print("""
=========================================================================================
RÉGIME PERMANENT — charge constante, seul le bruit du compteur excite la boucle
=========================================================================================""")
def permanent(K, smith, d=1, n=4320, seed=1):     # 24 h à 20 s
    rng = np.random.default_rng(seed)
    u = np.zeros(n + d + 2); dep = []; ecr = 0; L = 900.0
    for k in range(n):
        g_vrai = L - u[max(0, k - d)]
        g = g_vrai + rng.normal(0, SIGMA)
        en_vol = sum(dep[-d:]) if (smith and d > 0) else 0.0
        cible = float(np.clip(u[k] + K * (g - en_vol), 0.0, U_MAX))
        delta = cible - u[k]
        if abs(delta) > 100.0: u[k+1] = cible; ecr += 1; dep.append(delta)
        else: u[k+1] = u[k]; dep.append(0.0)
    return ecr
print("  stratégie                 K    écritures/jour")
for lbl, K, sm in [("service actuel", 1.0, False), ("gain réduit", 0.7, False),
                   ("gain réduit", 0.5, False), ("Smith + gain plein", 1.0, True)]:
    print("  %-22s %.1f  %10d" % (lbl, K, permanent(K, sm)))
