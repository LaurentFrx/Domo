# -*- coding: utf-8 -*-
"""
ANALYSE DE STABILITÉ de la boucle SB3 — vérification symbolique (SymPy).

Modèle. À l'instant k (période d'échantillonnage Ts), la boucle écrit une
consigne u_k. La sortie PHYSIQUE des SB3 suit avec un retard de d périodes
(écriture cloud → application device). Le compteur mesure

    g_k = L_k − P_pv,k − u_{k−d} − m_k          (+ = achat EDF)

où m_k est la Max AC. Deux régimes :

  (A) Max AC NON saturée : elle asservit g→0 en quelques secondes (boucle
      interne rapide). Notre boucle voit g≈0 : elle ne corrige rien, seul le
      rééquilibrage de partage agit. Pas de problème de stabilité.

  (B) Max AC SATURÉE (m = m_max) : notre boucle est le SEUL régulateur. C'est
      le cas dimensionnant — et c'est exactement la situation du 28/07
      (cumulus 3 kW, Max AC à 2 kW de sortie max).

Loi implémentée : u_{k+1} = u_k + K·g_k   (actuellement K = 1).
"""
import sympy as sp

z, K = sp.symbols('z K', positive=True)

print("=" * 74)
print("1. ÉQUATION CARACTÉRISTIQUE EN BOUCLE FERMÉE (régime B)")
print("=" * 74)
print("""
   u_{k+1} = u_k + K·g_k  et  g_k = C − u_{k−d}   (C = L − P_pv − m_max)
   ⇒ u_{k+1} − u_k + K·u_{k−d} = K·C
   En z :        z^{d+1} − z^d + K = 0
""")

def marge(d, kmax=2.0, pas=0.0005):
    """Plus grand K tel que toutes les racines soient dans le disque unité."""
    best, best_rho = 0.0, None
    k = pas
    while k <= kmax:
        poly = sp.Poly(z**(d+1) - z**d + k, z)
        rho = max(abs(complex(r)) for r in sp.nroots(poly, n=15))
        if rho < 1 - 1e-9:
            best, best_rho = k, rho
        else:
            break
        k += pas
    return best, best_rho

print("=" * 74)
print("2. GAIN MAXIMAL ADMISSIBLE SELON LE RETARD (rayon spectral < 1)")
print("=" * 74)
print("   d = retard en périodes d'échantillonnage\n")
print("   d   K_max   ρ(K_max)   K=1 stable ?   ρ(K=1)")
res = {}
for d in range(0, 6):
    kmax, rho = marge(d)
    poly1 = sp.Poly(z**(d+1) - z**d + 1, z)
    rho1 = max(abs(complex(r)) for r in sp.nroots(poly1, n=15))
    res[d] = (kmax, rho1)
    print("   %d   %5.3f   %7.4f    %-12s  %.4f" %
          (d, kmax, rho or 0, "OUI" if rho1 < 1 else "NON", rho1))

print("""
   Lecture : sans retard (d=0), K=1 est le réglage « deadbeat » — erreur
   annulée en UNE période, optimal. Dès d=1, K=1 place les racines SUR le
   cercle unité (ρ=1) : oscillation entretenue, jamais amortie.
""")

print("=" * 74)
print("3. DÉMONSTRATION ANALYTIQUE POUR d = 1")
print("=" * 74)
sol = sp.solve(sp.Eq(z**2 - z + K, 0), z)
print("   racines de z² − z + K :")
for s in sol: print("     ", sp.simplify(s))
print("""
   Pour K > 1/4 les racines sont complexes conjuguées, de produit K (relation
   de Viète : z₁·z₂ = K). Donc |z₁| = |z₂| = √K, et la stabilité asymptotique
   exige √K < 1, soit :

              ★  K < 1  pour d = 1   (K = 1 ⇒ oscillation entretenue)  ★

   L'amortissement par période vaut √K. Pour amortir d'un facteur 10 en n
   périodes : K = 10^(−2/n).
""")
for n in (2, 3, 4, 5, 8):
    print("     amortissement ×10 en %d périodes → K = %.3f" % (n, 10**(-2.0/n)))

print("""
=" * 74""")
print("=" * 74)
print("4. CHOIX DU GAIN — compromis rapidité / marge")
print("=" * 74)
print("""
   Contrainte de Laurent : « aucune réaction différée ». Un gain trop faible
   EST une réaction différée déguisée (il faut n périodes pour couvrir le
   déficit). Il faut donc le K le plus grand compatible avec la stabilité.

   Erreur résiduelle après n périodes, pour un échelon de charge, en d=1 :
      e_n / e_0 = K^{n/2}
""")
for k in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0):
    ligne = "   K=%.1f : " % k
    for n in (1, 2, 3, 5, 10):
        ligne += " n=%-2d %5.1f%% |" % (n, 100 * k**(n/2.0))
    print(ligne)
print("""
   K = 0,7 : 84 %% du déficit couvert en 1 période, 97 %% en 3, marge √0,7=0,84.
   K = 0,5 : plus robuste mais 71 %% en 1 période seulement.
""")
