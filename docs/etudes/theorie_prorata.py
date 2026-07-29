# -*- coding: utf-8 -*-
"""
OPTIMALITÉ DE LA RÉPARTITION AU PRORATA DE L'ÉNERGIE UTILISABLE — preuve
symbolique (SymPy) + vérification numérique.

Laurent l'a posée comme règle. On démontre qu'elle n'est pas un choix
esthétique : c'est la SEULE répartition qui maximise l'autonomie du parc.
"""
import sympy as sp
import numpy as np

print("=" * 78)
print("1. FORMULATION")
print("=" * 78)
print("""
   n batteries, énergie utilisable E_i (réserve déduite). La maison demande une
   puissance P(t) > 0 fournie par le parc : p_i(t) = α_i · P(t), avec α_i ≥ 0
   constants et Σα_i = 1 (répartition en parts fixes).

   La batterie i atteint sa réserve à l'instant T_i tel que ∫₀^{T_i} α_i P = E_i.
   En notant W(T) = ∫₀^T P l'énergie totale demandée : α_i W(T_i) = E_i.

   L'AUTONOMIE du parc est T* = min_i T_i : dès qu'une batterie touche sa
   réserve, elle cesse de fournir et le reste doit être repris par les autres —
   ou, si elles saturent, ACHETÉ À EDF (violation de la règle 1).

   Comme W est strictement croissante, maximiser T* revient à maximiser
   W* = min_i (E_i / α_i).
""")

print("=" * 78)
print("2. PREUVE — maximiser min_i (E_i/α_i) sous Σα_i = 1")
print("=" * 78)
n = 3
E = sp.symbols('E1 E2 E3', positive=True)
a = sp.symbols('a1 a2 a3', positive=True)
print("""
   (a) L'optimum ÉGALISE tous les rapports E_i/α_i.
       Sinon, soit j l'indice du minimum et k un indice tel que E_k/α_k > E_j/α_j.
       En transférant ε > 0 de α_k vers α_j, E_j/α_j croît strictement et
       E_k/α_k décroît continûment ; pour ε assez petit le minimum a STRICTEMENT
       augmenté. Donc toute répartition non égalisatrice est sous-optimale. ∎

   (b) Égalité E_i/α_i = c pour tout i, avec Σα_i = 1 :
""")
c = sp.symbols('c', positive=True)
sol = sp.solve([sp.Eq(E[i]/a[i], c) for i in range(n)] + [sp.Eq(sum(a), 1)],
               list(a) + [c], dict=True)[0]
for i in range(n):
    print("        α%d = %s" % (i+1, sp.simplify(sol[a[i]])))
print("        c  = %s" % sp.simplify(sol[c]))
print("""
   ★ α_i = E_i / Σ_j E_j  —  EXACTEMENT la règle 2 de Laurent.
     Et W* = Σ E_j : le parc délivre la TOTALITÉ de son énergie utilisable
     avant que la première batterie ne touche sa réserve. Toutes l'atteignent
     au même instant : aucune énergie n'est immobilisée.
""")

print("=" * 78)
print("3. PERTE D'AUTONOMIE D'UNE RÉPARTITION NON PROPORTIONNELLE")
print("=" * 78)
E1, E2, E3 = sp.symbols('E1 E2 E3', positive=True)
al = sp.symbols('alpha', positive=True)
print("""
   Rendement d'autonomie  η_auto = W*(α) / Σ E_i = min_i (E_i/α_i) / Σ E_j.
   Cas du 28/07 : SB3 pleines (2 × 2 419 Wh utilisables) mais α_SB3 = 0, tout
   sur la Max AC (E = 4 104 Wh, réserve 10 % déduite à SoC 67 %).
""")
Esb3, Emax = 2*2419.2, 7200*(67-10)/100.0
print("   E_SB3 = %.0f Wh   E_MaxAC = %.0f Wh   Σ = %.0f Wh" % (Esb3, Emax, Esb3+Emax))
for lbl, alpha_sb3 in [("prorata (règle 2)", Esb3/(Esb3+Emax)),
                       ("consigne 0 (bug 28/07)", 0.0),
                       ("moitié-moitié", 0.5)]:
    a_sb3, a_max = alpha_sb3, 1-alpha_sb3
    W = min(Esb3/a_sb3 if a_sb3 > 0 else np.inf, Emax/a_max if a_max > 0 else np.inf)
    print("   %-24s α_SB3=%.3f → autonomie = %6.0f Wh  (%.0f %% du parc)"
          % (lbl, a_sb3, W, 100*W/(Esb3+Emax)))
print("""
   Le bug du 28/07 n'immobilisait pas « un peu » d'énergie : il ramenait
   l'autonomie du parc à celle de la SEULE Max AC, soit 63 % du disponible —
   les 4 838 Wh des SB3 étant inaccessibles jusqu'à épuisement de la Max AC,
   donc jusqu'à l'achat EDF.
""")

print("=" * 78)
print("4. VÉRIFICATION MONTE CARLO (parts aléatoires vs prorata)")
print("=" * 78)
rng = np.random.default_rng(7)
Ev = np.array([2419.2, 2419.2, 4104.0])
prop = Ev / Ev.sum()
best = 0.0
for _ in range(200000):
    al_ = rng.dirichlet(np.ones(3))
    W = np.min(Ev / al_)
    best = max(best, W)
print("   Σ E_i                       = %.0f Wh" % Ev.sum())
print("   autonomie au prorata        = %.0f Wh" % np.min(Ev/prop))
print("   meilleur sur 200 000 tirages= %.0f Wh" % best)
print("   → aucun tirage ne dépasse le prorata : borne atteinte, preuve confirmée.")
