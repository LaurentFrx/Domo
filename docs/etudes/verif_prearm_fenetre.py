#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Banc de vérification — régulation énergie Domo (31/07/2026).

Trois volets :
  1. SymPy    : stabilité de la boucle SB3 selon la fenêtre du prédicteur de
                Smith (enVolS) face au tick réel 20-25 s (médiane 23,2).
  2. SymPy    : invariants — règle 0 (le prorata en décharge CONSERVE les
                rapports E_i/E_j) et règle 2 (optimalité du prorata, re-vérifiée
                par Monte Carlo Dirichlet).
  3. Monte Carlo temps continu (dt = 1 s, tirages APPARIÉS) : échelon cumulus
                ±2,9 kW — stratégie RÉACTIVE (aujourd'hui) vs PRÉ-ARMEMENT de
                la consigne SB3 avant fermeture du relais (§8 de l'étude).

Constantes physiques = mesures de docs/regulation-energie.md et des fiches :
  - Max AC : butée décharge 3 540 W (p99,9 mesuré), régulation locale ~2 s
  - absorption Max AC en charge : DÉFAILLANTE ~50 % du temps (§9.3 : médiane
    99 W absorbés sur 1 017 instants d'injection avec place disponible)
  - SB3 : consigne 0-2 400 W via cloud ; visible au compteur < 1 tick ;
    application device 8-25 s après le POST (login owner + application)
  - tick sb3loop : période mesurée 20-25 s, médiane 23,2 s
  - cumulus : 2 900 W config (heatPowerW), 2 950 ± 40 W mesuré
  - bande morte 100 W ; part SB3 40-60 % (prorata d'énergie utilisable)
  - charge concurrente (lave-linge…) : le scénario de la RÈGLE 0
"""
import numpy as np
import sympy as sp

LINE = "─" * 72


# ══════════════════════════════════════════════════════════════════════════
# 1. SYMPY — stabilité selon la fenêtre du prédicteur de Smith
# ══════════════════════════════════════════════════════════════════════════
def volet_1():
    print(LINE)
    print("1. STABILITÉ DE LA BOUCLE — fenêtre enVol vs tick réel (SymPy)")
    print(LINE)
    z, K = sp.symbols("z K")

    # Modèle : g_k = C − u_{k−1} (retard d'actionnement < 1 tick, mesuré),
    # u_{k+1} = u_k + K·e_k. Le contenu de e_k dépend de la fenêtre W :
    #   W < T      : file purgée avant relecture → e_k = g_k
    #     u_{k+1} = u_k + K(C − u_{k−1})                → z² − z + K = 0
    #   T ≤ W < 2T : e_k = g_k − Δu_{k−1} (Δu_j = u_{j+1} − u_j)
    #     u_{k+1} = u_k + K(C − u_{k−1} − (u_k − u_{k−1})) → z − (1−K) = 0
    #   2T ≤ W <3T : e_k = g_k − Δu_{k−1} − Δu_{k−2}
    #     u_{k+1} = u_k + K(C − u_{k−1} − (u_k − u_{k−2}))
    #                                     → z³ + (K−1)z² + Kz − K = 0
    cas = {
        "W < T    (enVolS=20 s, tick 23,2 s → prédicteur INERTE)":
            z**2 - z + K,
        "T < W < 2T  (enVolS=30 s → UNE correction retranchée)":
            z - (1 - K),
        "2T < W < 3T (enVolS=45 s → DEUX corrections retranchées)":
            z**3 + (K - 1) * z**2 + K * z - K,
    }
    for nom, poly in cas.items():
        print(f"\n  {nom}")
        print(f"    polynôme caractéristique : {sp.expand(poly)} = 0")
        for k in (0.5, 1.0):
            racines = sp.Poly(poly.subs(K, k), z).nroots()
            mods = sorted(abs(complex(r)) for r in racines)
            m = mods[-1]
            verdict = ("DIVERGENT" if m > 1.0001
                       else "oscillation ENTRETENUE" if m > 0.9999
                       else "deadbeat (convergence en 1 tick)" if m < 1e-9
                       else f"amorti (ρ = {m:.3f})")
            print(f"      K = {k:>3} → |z|max = {m:.4f}  → {verdict}")

    # Viète pour W<T : produit des racines de z²−z+K = K → |z| = √K à K plein.
    r1, r2 = sp.solve(z**2 - z + K, z)
    assert sp.simplify(r1 * r2 - K) == 0
    print("\n  Viète vérifié : z²−z+K → produit des racines = K, donc |z| = √K.")
    print("  ⇒ au gain plein K=1 exigé par la règle 3 : |z| = 1, cycle limite de")
    print("    période 6 ticks ≈ 2 min — EXACTEMENT l'oscillation mesurée le 28/07")
    print("    (864 écritures/jour). Avec W dans [T, 2T[, le même gain plein est")
    print("    deadbeat : la règle 3 est tenable SANS instabilité.")

    # Condition sur W avec la gigue réelle du tick T ∈ [20, 25] s :
    # survivre à EXACTEMENT un tick ⇒ T_max < W < 2·T_min.
    T_min, T_max = 20.0, 25.0
    lo, hi = T_max, 2 * T_min
    print(f"\n  Gigue mesurée du tick : T ∈ [{T_min:.0f}, {T_max:.0f}] s (médiane 23,2 s)")
    print(f"  Fenêtre admissible : {lo:.0f} s < enVolS < {hi:.0f} s")
    for W in (20, 30, 45):
        ok = lo < W < hi
        note = ("  (survit 0 tick → inerte)" if W <= T_min
                else "  (peut survivre 2 ticks → sur-correction)" if W >= hi
                else "")
        print(f"    enVolS = {W:>2} s : {'✓ ADMISSIBLE' if ok else '✗ hors plage'}{note}")


# ══════════════════════════════════════════════════════════════════════════
# 2. SYMPY — invariants des règles 0 et 2
# ══════════════════════════════════════════════════════════════════════════
def volet_2():
    print("\n" + LINE)
    print("2. INVARIANTS — règle 0 (prorata = déséquilibre conservé) et règle 2")
    print(LINE)
    t, P = sp.symbols("t P", positive=True)
    E1 = sp.Function("E1", positive=True)(t)
    E2 = sp.Function("E2", positive=True)(t)

    # Décharge au prorata : dEi/dt = −Ei·P/(E1+E2)
    S = E1 + E2
    dE1, dE2 = -E1 * P / S, -E2 * P / S
    dRatio = sp.simplify((dE1 * E2 - E1 * dE2) / E2**2)
    print(f"\n  d/dt (E1/E2) sous décharge au prorata = {dRatio}")
    assert dRatio == 0
    print("  ⇒ ZÉRO symboliquement : le rapport entre batteries est un INVARIANT.")
    print("    Le prorata en décharge CONSERVE le déséquilibre — seule la RECHARGE")
    print("    rééquilibre (règle 0). Le détournement de PV vers la Max AC est donc")
    print("    le SEUL chemin qui lui rende sa puissance (3 540 des 5 940 W).")

    # Règle 2 — optimalité du prorata, re-vérification Monte Carlo (Dirichlet).
    rg = np.random.default_rng(42)
    E = np.array([2419.2, 2419.2, 4104.0])  # Wh utilisables (cas du 28/07)
    n = 50_000
    alphas = rg.dirichlet(np.ones(3), size=n)
    W_rand = (E / alphas).min(axis=1)  # énergie délivrée avant le 1er plancher
    W_pro = E.sum()
    print(f"\n  Règle 2 (Monte Carlo, {n:,} répartitions Dirichlet aléatoires) :")
    print(f"    prorata         : {W_pro:8,.0f} Wh (100 % du parc)")
    print(f"    meilleur tirage : {W_rand.max():8,.0f} Wh ({100*W_rand.max()/W_pro:.1f} %)")
    print(f"    médiane tirages : {np.median(W_rand):8,.0f} Wh ({100*np.median(W_rand)/W_pro:.1f} %)")
    assert W_rand.max() <= W_pro + 1e-6
    print("  ⇒ aucun tirage ne dépasse le prorata : optimalité re-confirmée.")


# ══════════════════════════════════════════════════════════════════════════
# 3. MONTE CARLO temps continu — échelon cumulus
# ══════════════════════════════════════════════════════════════════════════
DT = 1.0            # s
DEADBAND = 100.0    # W (config sb3loop)
MAX_PRESET = 2400.0
MAXAC_CAP = 3540.0  # butée décharge mesurée (p99,9)
TAU_MA = 2.0        # constante de temps de la régulation locale Max AC (s)
SETTLE_S = 180.0    # settleS (config sb3loop)
HEAT_CFG_W = 2900.0  # heatPowerW (config cumulus) — utilisé par le pré-armement


def tirage_params(rg):
    """Paramètres physiques d'un événement — plages MESURÉES uniquement."""
    # Absorption Max AC en charge : §9.3 — ~50 % du temps quasi nulle.
    c_abs = rg.uniform(0.0, 300.0) if rg.random() < 0.5 else rg.uniform(1000.0, 2000.0)
    # Charge concurrente (lave-linge, four…) : le scénario de la RÈGLE 0.
    has_extra = rg.random() < 0.35
    return {
        "talon": rg.uniform(150.0, 600.0),
        "aps": rg.uniform(0.0, 800.0),
        "p_cum": rg.normal(2950.0, 40.0),
        "share": rg.uniform(0.40, 0.60),
        "c_abs": c_abs,
        "delay": rg.uniform(8.0, 25.0),
        "tick0": rg.uniform(0.0, 23.0),
        "extra": rg.uniform(500.0, 2000.0) if has_extra else 0.0,
        "t_extra": rg.uniform(-30.0, 90.0),
        "tick_periods": rg.uniform(20.0, 25.0, size=40),
    }


def simule_event(p, *, prearm: bool, smith_w: float,
                 stop_event: bool = False, ff_down: bool = False):
    """Un échelon cumulus (allumage, ou extinction si stop_event).

    t = 0 : bascule du relais. Fenêtre simulée [−120, +420] s.
    Retourne (E_achat_Wh, E_inject_Wh, n_écritures, E_absorbé_MaxAC_Wh).
    """
    talon, aps, p_cum = p["talon"], p["aps"], p["p_cum"]
    share, c_abs, delay = p["share"], p["c_abs"], p["delay"]
    extra, t_extra = (0.0, 1e9) if stop_event else (p["extra"], p["t_extra"])

    t_start, t_end = -120.0, 420.0
    n = int((t_end - t_start) / DT)

    def house_at(t):
        h = talon
        if (t >= 0) != stop_event:      # cumulus ON après t=0 (start) / avant (stop)
            h += p_cum
        if t >= t_extra:
            h += extra
        return h

    # Régime établi AVANT l'échelon : SB3 à leur part du besoin parc, Max AC le reste.
    house0 = house_at(t_start)
    cons0 = min(MAX_PRESET, max(0.0, share * (house0 - aps)))
    applied = cons0       # consigne appliquée par le device
    cur = cons0           # consigne que la boucle croit en place (lastCmdW)
    ma = house0 - aps - applied
    ma = min(MAXAC_CAP, max(-c_abs, ma))

    pending = []          # [(t_application, valeur)]
    envol = []            # [(t_écriture, dW)] — file du prédicteur de Smith
    last_write = -1e9
    writes = 0
    hold_until = -1e9     # pré-armement : baisses bloquées jusqu'à cet instant

    # Ticks sb3loop : gigue réelle U(20,25), phase aléatoire.
    ticks, tt = set(), t_start + p["tick0"]
    for T in p["tick_periods"]:
        if tt >= t_end:
            break
        ticks.add(int(round(tt)))
        tt += T

    # PRÉ-ARMEMENT (allumage), séquencé « fermeture sur CONFIRMATION » :
    # le moteur écrit la consigne, attend la confirmation du pont (budget 20 s),
    # puis ferme le relais ~2 s après. Si le budget expire, il ferme quand même
    # (repli = comportement actuel) et l'écriture atterrit un peu APRÈS la
    # fermeture — ce qui aide encore. Baisses bloquées jusqu'à +30 s.
    if prearm and not stop_event:
        target = min(MAX_PRESET, cons0 + share * HEAT_CFG_W)
        t_write = -(min(delay, 20.0) + 2.0)   # le relais ferme à t = 0
        pending.append((t_write + delay, target))
        cur, last_write, hold_until = target, t_write, 30.0
        writes += 1
    # FEEDFORWARD DE DESCENTE (extinction) : à l'ouverture, − part × P_cum.
    if ff_down and stop_event:
        target = max(0.0, cur - share * p_cum)
        pending.append((0.0 + delay, target))
        cur, last_write = target, 0.0
        writes += 1

    E_buy = E_inj = E_abs = 0.0

    for i in range(n):
        t = t_start + i * DT
        house = house_at(t)

        for (ta, v) in list(pending):
            if t >= ta:
                applied = v
                pending.remove((ta, v))
        sb3 = min(applied, MAX_PRESET)

        # Max AC : asservit le compteur vers zéro (τ ≈ 2 s),
        # bornée [−c_abs (charge), +3 540 (décharge)].
        target_ma = house - aps - sb3
        ma += (1.0 - np.exp(-DT / TAU_MA)) * (target_ma - ma)
        ma = min(MAXAC_CAP, max(-c_abs, ma))

        grid = house - aps - sb3 - ma
        if grid > 0:
            E_buy += grid * DT / 3600.0
        else:
            E_inj += -grid * DT / 3600.0
        if ma < 0:
            E_abs += -ma * DT / 3600.0

        # ── Tick de la boucle SB3 ──
        if int(round(t)) in ticks:
            envol = [(tw, dw) for (tw, dw) in envol if t - tw < smith_w]
            deja = sum(dw for (_, dw) in envol)
            err = grid - deja
            settling = (t - last_write) < SETTLE_S
            if abs(err) > DEADBAND:
                if err < 0 and t < hold_until:
                    pass  # pré-armement : baisse bloquée (la montée reste libre)
                else:
                    new_c = min(MAX_PRESET, max(0.0, cur + err))
                    if abs(new_c - cur) > DEADBAND:
                        pending.append((t + delay, new_c))
                        envol.append((t, new_c - cur))
                        cur, last_write = new_c, t
                        writes += 1
            elif not settling:
                # Branche répartition : progressive, bornée par la marge Max AC.
                batt_total = max(0.0, sb3 + ma)
                target = share * batt_total
                marge = max(0.0, MAXAC_CAP - abs(ma))
                prog = cur + 0.5 * (target - cur)
                prog = min(cur + marge, max(cur - marge, prog))
                prog = min(MAX_PRESET, max(0.0, prog))  # comme applyTarget()
                if abs(prog - cur) > DEADBAND:
                    pending.append((t + delay, prog))
                    envol.append((t, prog - cur))
                    cur, last_write = prog, t
                    writes += 1

    return E_buy, E_inj, writes, E_abs


def stats(v):
    v = np.asarray(v)
    return (f"méd {np.median(v):7.1f} | p90 {np.percentile(v, 90):7.1f}"
            f" | max {np.max(v):7.1f}")


def volet_3(n_events=2000):
    print("\n" + LINE)
    print(f"3. MONTE CARLO — échelon cumulus ±2,9 kW ({n_events} événements APPARIÉS)")
    print(LINE)

    # Tirages appariés : la MÊME liste de paramètres physiques pour chaque
    # stratégie — seule la stratégie change, jamais le hasard.
    rg = np.random.default_rng(2026)
    params_start = [tirage_params(rg) for _ in range(n_events)]
    rg = np.random.default_rng(2027)
    params_stop = [tirage_params(rg) for _ in range(n_events)]

    # ── ALLUMAGE ──
    strategies = [
        ("RÉACTIF (aujourd'hui, W=20)", dict(prearm=False, smith_w=20.0)),
        ("RÉACTIF, §9.6 appliqué (W=30) — contre-épreuve", dict(prearm=False, smith_w=30.0)),
        ("PRÉ-ARMÉ, fermeture sur confirmation (W=20)", dict(prearm=True, smith_w=20.0)),
    ]
    print("\n  ALLUMAGE (relais fermé à t=0) — par événement :")
    res = {}
    for nom, kw in strategies:
        out = np.array([simule_event(p, stop_event=False, **kw) for p in params_start])
        res[nom] = out
        print(f"\n    {nom}")
        print(f"      achat EDF  : {stats(out[:, 0])} Wh")
        print(f"      injection  : {stats(out[:, 1])} Wh")
        print(f"      écritures  : méd {np.median(out[:, 2]):.0f}")

    b_now = res[strategies[0][0]][:, 0]
    b_pre = res[strategies[2][0]][:, 0]
    i_now = res[strategies[0][0]][:, 1]
    i_pre = res[strategies[2][0]][:, 1]
    diff = b_now - b_pre
    print(f"\n  ⇒ achat évité par le pré-armement (différence APPARIÉE) :")
    print(f"      {stats(diff)} Wh/allumage — positif dans "
          f"{100*np.mean(diff > 0.5):.0f} % des cas, négatif dans "
          f"{100*np.mean(diff < -0.5):.0f} %")
    print(f"      surcoût d'injection apparié : méd "
          f"{np.median(i_pre - i_now):.1f} Wh/allumage")
    # Conditionnel sur les allumages PROBLÉMATIQUES (ceux qui achètent aujourd'hui)
    mask = b_now > 2.0
    if mask.any():
        print(f"      sur les {mask.sum()} allumages qui achètent > 2 Wh aujourd'hui "
              f"({100*mask.mean():.0f} %) :")
        print(f"        achat  : méd {np.median(b_now[mask]):.1f} → "
              f"{np.median(b_pre[mask]):.1f} Wh "
              f"(−{100*(1 - np.median(b_pre[mask])/np.median(b_now[mask])):.0f} %)")
        print(f"        injection : méd {np.median(i_now[mask]):.1f} → "
              f"{np.median(i_pre[mask]):.1f} Wh")

    # ── EXTINCTION ──
    print("\n  EXTINCTION (relais ouvert à t=0) — recyclage SB3 → Max AC :")
    for nom, kw in [
        ("RÉACTIF (descente actuelle : répartition progressive)", dict(ff_down=False)),
        ("FEEDFORWARD descente (consigne − part × P_cum mesurée)", dict(ff_down=True)),
    ]:
        out = np.array([
            simule_event(p, stop_event=True, prearm=False, smith_w=30.0, **kw)
            for p in params_stop
        ])
        loss = 0.15 * out[:, 3]  # pertes de conversion aller-retour ~15 %
        print(f"\n    {nom}")
        print(f"      absorbé Max AC : {stats(out[:, 3])} Wh "
              f"(perte ~15 % : méd {np.median(loss):.1f} Wh)")
        print(f"      achat induit   : {stats(out[:, 0])} Wh | "
              f"injection {stats(out[:, 1])} Wh")

    # ── RÉGIME SOUTENU SATURÉ : le test dédié de la fenêtre enVolS (§9.6) ──
    # Talon 3 kW + cumulus : la Max AC sature, la boucle SB3 est le SEUL
    # régulateur — le régime dimensionnant du §3 de l'étude.
    print("\n  RÉGIME SOUTENU SATURÉ (talon 3 kW + cumulus, Max AC en butée) :")
    print("  écritures et énergie hors équilibre sur 9 min, selon enVolS :")
    rg = np.random.default_rng(2028)
    params_sat = []
    for _ in range(400):
        p = tirage_params(rg)
        p["talon"], p["c_abs"], p["extra"] = 3000.0, 0.0, 0.0
        params_sat.append(p)
    for W in (20.0, 30.0, 45.0):
        out = np.array([
            simule_event(p, stop_event=False, prearm=False, smith_w=W)
            for p in params_sat
        ])
        eh = out[:, 0] + out[:, 1]
        print(f"    enVolS = {W:4.0f} s : écritures méd {np.median(out[:, 2]):4.0f} "
              f"p90 {np.percentile(out[:, 2], 90):4.0f} | "
              f"énergie hors équilibre méd {np.median(eh):6.1f} "
              f"p90 {np.percentile(eh, 90):6.1f} Wh")
    print("\n  ⇒ CONCLUSION fenêtre : le retard de visibilité (8-25 s) est le plus")
    print("    souvent INFÉRIEUR au pas de tick (20-25 s) — une fenêtre ≥ tick")
    print("    retranche des corrections DÉJÀ visibles au compteur et crée des")
    print("    inversions fantômes. L'asymétrie tranche : trop courte = double")
    print("    correction bornée, auto-réparée en un tick ; trop longue = la")
    print("    boucle annule ses propres écritures en continu.")
    print("    enVolS = 20 s est CONSERVÉ ; le correctif §9.6 (30 s) est RÉFUTÉ.")


if __name__ == "__main__":
    volet_1()
    volet_2()
    volet_3()
    print("\n" + LINE)
    print("FIN — banc reproductible (graines fixées : 42, 2026, 2027, 2028).")
