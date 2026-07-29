# -*- coding: utf-8 -*-
"""VALIDATION FINALE v2 — avec PLANCHER PV.

Découverte de la v1 : la consigne SB3 ne gouverne pas que la décharge batterie,
elle gouverne la SORTIE AC TOTALE, passage du PV propre des SB3 compris. La
descendre sous la production PV des packs revient à ÉCRÊTER du solaire gratuit
dès que les packs sont pleins (plus de place pour l'absorber en DC).

Plancher physique :  u_min = max(0, PV_sb3·η − place_disponible_en_puissance)
Le terme anti-recyclage ne peut donc retirer que la part BATTERIE de la sortie.
"""
import numpy as np
exec(open('mc_loi.py').read().split("JEUX = ")[0])
SETTLE = int(180/Ts)

def sim(L, pv_sb3, pv_aps, bruit, K=1.0, Kr=1.0, dbu=100.0, dbl=400.0,
        d=1, mode='deploye', plancher=True):
    u = np.zeros(N+d+2); soc_m, soc_s = 0.67, 1.00
    achat=inj=recyc=0.0; ecr=0; last=-10**6; ecrete=0.0
    for k in range(N):
        u_eff = max(0.0, u[max(0,k-d)])
        place_w = max(0.0, (1-soc_s)*SB3_E)/Ts*3600          # W absorbables en DC
        sortie = min(u_eff, pv_sb3[k]+U_MAX)
        # PV SB3 non absorbé et non sorti = écrêté (perdu)
        ecrete += max(0.0, pv_sb3[k] - sortie/ETA - place_w)*Ts/3600.0
        surplus = pv_aps[k] + sortie - L[k]
        if surplus > 0:
            m = -min(surplus, MAXAC_P, max(0.0,(1-soc_m)*MAXAC_E)/Ts*3600)
        else:
            m = min(-surplus, MAXAC_P, max(0.0,(soc_m-RESERVE)*MAXAC_E)/Ts*3600)
        g = L[k] - pv_aps[k] - sortie - m
        achat += max(0.0,g)*Ts/3600.0; inj += max(0.0,-g)*Ts/3600.0
        soc_m -= (m/ETA if m>0 else m*ETA)*Ts/3600.0/MAXAC_E; soc_m=min(1,max(0,soc_m))
        batt = max(0.0, sortie/ETA - pv_sb3[k])
        ch = min(place_w, max(0.0, pv_sb3[k]-sortie/ETA))
        soc_s += (ch*ETA - batt)*Ts/3600.0/SB3_E; soc_s=min(1,max(0,soc_s))
        r = min(max(0.0,-m), batt) if m<0 else 0.0
        recyc += r*Ts/3600.0
        gm = g + bruit[k]
        Es = max(0.0, SB3_E*(soc_s-RESERVE)); Em = max(0.0, MAXAC_E*(soc_m-RESERVE))
        alpha = Es/(Es+Em) if Es+Em>0 else 0.0
        u_min = max(0.0, (pv_sb3[k] - place_w)*ETA) if plancher else 0.0
        settling = (k-last) < SETTLE
        if abs(gm) > dbu:
            cible, seuil = u[k] + K*gm, dbu
        elif settling:
            cible, seuil = u[k], 10**9
        elif mode=='propose' and r > dbl:
            cible, seuil = u[k] - Kr*r, dbl
        else:
            flux = max(0.0,m) if mode=='deploye' else m
            cible = alpha*max(0.0, sortie+flux)
            seuil = dbu if mode=='deploye' else dbl
        cible = min(U_MAX, max(u_min if mode=='propose' else 0.0, cible))
        if abs(cible-u[k]) > seuil: u[k+1]=cible; ecr+=1; last=k
        else: u[k+1]=u[k]
    return achat, inj, recyc, ecr, soc_s, soc_m, ecrete

JEUX=[scenario(r) for r in range(80)]
A=np.array([sim(*j, mode='deploye') for j in JEUX])
parc=lambda o:(o[:,4]*SB3_E+o[:,5]*MAXAC_E).mean()/1000
print("="*102)
print("VALIDATION FINALE — 24 h, 80 réalisations appariées, gel settle + plancher PV")
print("="*102)
print("  loi                        achat kWh/j  recyc  écrêté PV  écr./j  parc restant")
print("  A. EN SERVICE              %10.3f %7.3f %10.3f %7.0f    %5.2f kWh"
      % (A[:,0].mean()/1000, A[:,2].mean()/1000, A[:,6].mean()/1000, A[:,3].mean(), parc(A)))
best=None
for K in (0.9, 1.0):
    for dbl in (250, 400):
        B=np.array([sim(*j,K=K,dbl=dbl,mode='propose') for j in JEUX])
        da=(B[:,0]-A[:,0])/1000
        dp=(B[:,4]*SB3_E+B[:,5]*MAXAC_E-A[:,4]*SB3_E-A[:,5]*MAXAC_E)/1000
        de=(B[:,6]-A[:,6])/1000
        n=len(JEUX); f=lambda x:1.96*x.std(ddof=1)/np.sqrt(n)
        print("  B. K=%.1f bande lente %d W  %8.3f %7.3f %10.3f %7.0f    %5.2f kWh"
              % (K,dbl,B[:,0].mean()/1000,B[:,2].mean()/1000,B[:,6].mean()/1000,B[:,3].mean(),parc(B)))
        print("       Δachat %+.3f±%.3f | Δparc %+.2f±%.2f kWh | Δécrêté %+.3f±%.3f | écritures %.0f→%.0f"
              % (da.mean(),f(da),dp.mean(),f(dp),de.mean(),f(de),A[:,3].mean(),B[:,3].mean()))
        sc=da.mean()-0.05*dp.mean()+de.mean()*0.05+max(0,B[:,3].mean()-120)*0.001
        if best is None or sc<best[0]: best=(sc,K,dbl,B,da,dp,de,f)
sc,K,dbl,B,da,dp,de,f=best
print("\n  ★ RETENU : K = %.1f | bande urgente 100 W | bande lente %d W | Kr = 1,0 | plancher PV actif"%(K,dbl))
print("    Δ achat EDF  %+.3f ± %.3f kWh/j   %s"%(da.mean(),f(da),"significatif" if abs(da.mean())>f(da) else "NON significatif"))
print("    Δ parc 24 h  %+.2f ± %.2f kWh     %s"%(dp.mean(),f(dp),"significatif" if abs(dp.mean())>f(dp) else "NON significatif"))
print("    écritures    %.0f → %.0f par jour"%(A[:,3].mean(),B[:,3].mean()))
