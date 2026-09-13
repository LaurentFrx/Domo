/**
 * Loi de commande de la boucle de charge Max AC — fonction PURE (testable sans réseau).
 *
 * OBJECTIF : récupérer le PV que les SB3 brident quand elles sont pleines, en
 * commandant à la Max AC de charger davantage — sans jamais acheter au réseau.
 *
 * PRINCIPE. Le compteur est l'unique juge. Une consigne trop haute crée un
 * import, trop basse laisse partir du surplus. On asservit donc la consigne sur
 * l'erreur compteur, avec un gain < 1 parce que les SB3 régulent elles aussi :
 * deux régulateurs à gain unitaire sur le même point oscillent l'un contre
 * l'autre. Le pas est limité (slew) parce que les SB3 mettent dix à vingt
 * secondes à rouvrir leur production ; un échelon les laisserait derrière et le
 * compteur partirait en import le temps qu'elles rattrapent.
 *
 * HIÉRARCHIE (ordre d'évaluation strict, le premier qui s'applique gagne) :
 *   1. une mesure manque → rendre la main. On ne pilote JAMAIS à l'aveugle un
 *      appareil qui ne régule plus de lui-même.
 *   2. mise à l'écart après un abandon → rendre la main.
 *   3. une condition d'exploitation tombe → rendre la main.
 *   4. import persistant → abandon et mise à l'écart.
 *   5. régime normal → asservissement.
 *
 * ASYMÉTRIE ASSUMÉE : on descend vite (l'import est interdit) et on monte
 * lentement (le surplus perdu ne coûte rien de plus qu'aujourd'hui, où il est
 * intégralement bridé). Le mode sûr est toujours celui où l'appareil se
 * gouverne lui-même : au moindre doute, on y retourne.
 */
import type { MaxAcDecision, MaxAcLoopConfig, MaxAcLoopInputs, MaxAcLoopState } from './types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Place restante dans la Max AC, exprimée en puissance absorbable (W). */
function roomW(inputs: MaxAcLoopInputs, cfg: MaxAcLoopConfig): number {
  const roomWh = Math.max(0, cfg.maxAcCapacityWh * (1 - clamp(inputs.maxAcSocPct, 0, 100) / 100));
  return roomWh / cfg.fillHorizonH;
}

export function decideMaxAc(
  inputs: MaxAcLoopInputs,
  cfg: MaxAcLoopConfig,
  state: MaxAcLoopState
): MaxAcDecision {
  const st: MaxAcLoopState = { ...state, lastTickTs: inputs.now };
  const piloting = st.setpointW !== null;

  /** Rendre la main : consigne 0 puis mode 0. Sans effet si on ne pilotait pas. */
  const rendre = (reason: string): MaxAcDecision => {
    st.setpointW = null;
    st.importTicks = 0;
    return {
      mode: piloting ? 'leave' : 'idle',
      writeW: piloting ? 0 : null,
      targetW: null,
      reason,
      nextState: st
    };
  };

  // ── 1. Mesures indispensables ────────────────────────────────────────────
  if (!inputs.gridAvailable) return rendre('compteur EM-50 muet — on ne pilote pas à l’aveugle');
  if (!inputs.maxAcAvailable) return rendre('Max AC injoignable en Modbus');
  if (!inputs.sb3Available || inputs.sb3SocPct === null)
    return rendre('état des SB3 inconnu ou périmé — impossible de savoir si leur PV est bridé');
  if (inputs.cumulusW === null)
    return rendre('voie cumulus muette — une entrée absente ne vaut pas « pas de chauffe »');

  // Le mode RÉEL prime sur ce que l'état croit. Un appareil en mode 3 alors que
  // nous ne pilotons pas est le pire état possible : il n'absorbe rien et tout
  // part au réseau. La seule décision légale est de le lui rendre — jamais
  // d'« entrer » en supposant qu'il régule encore (sa charge lue vaudrait 0 et
  // on lui commanderait de rester inerte).
  if (!piloting && inputs.maxAcMode === 3)
    return {
      mode: 'leave',
      writeW: 0,
      targetW: null,
      reason: 'appareil resté en mode 3 sans pilotage — on lui rend sa régulation',
      nextState: { ...st, setpointW: null, importTicks: 0 }
    };
  if (piloting && inputs.maxAcMode !== null && inputs.maxAcMode !== 3)
    return rendre('mode 3 perdu (repli du chien de garde ou app Anker) — on repart de zéro');

  // ── 2. Mise à l'écart après un abandon ───────────────────────────────────
  if (inputs.now < st.penaltyUntilTs) {
    const restS = Math.round((st.penaltyUntilTs - inputs.now) / 1000);
    return rendre(`mise à l’écart après abandon — reprise dans ${restS} s`);
  }

  // ── 3. Conditions d'exploitation ─────────────────────────────────────────
  if (inputs.sb3SocPct < cfg.sb3FullPct)
    return rendre(
      `SB3 à ${Math.round(inputs.sb3SocPct)} % — elles ont besoin de leur PV, on ne le leur prend pas`
    );
  if (inputs.maxAcSocPct > cfg.maxAcRoomPct)
    return rendre(`Max AC à ${Math.round(inputs.maxAcSocPct)} % — plus de place à remplir`);
  if (inputs.apsW < cfg.dayApsW)
    return rendre(`APS à ${Math.round(inputs.apsW)} W — pas de soleil à récupérer`);
  if (inputs.cumulusW >= cfg.cumulusOnW)
    return rendre(
      `le chauffe-eau tire ${Math.round(inputs.cumulusW)} W — il crée déjà la demande, on lui laisse la place`
    );
  if (!piloting && inputs.sb3PvW >= cfg.sb3PvBridedW)
    return rendre(
      `PV des SB3 à ${Math.round(inputs.sb3PvW)} W — il n’est pas bridé, rien à débloquer`
    );

  // ── 3 bis. Les SB3 puisent-elles dans leur BATTERIE ? ────────────────────
  // Le SoC ne dit pas d'où viennent les watts. Si leur sortie AC dépasse leur PV,
  // c'est leur batterie qui alimente notre charge : transfert à pertes, refusé.
  if (piloting && inputs.sb3OutW > inputs.sb3PvW + cfg.sb3DrainMarginW)
    return rendre(
      `les SB3 sortent ${Math.round(inputs.sb3OutW)} W pour ${Math.round(inputs.sb3PvW)} W de PV — c'est leur batterie, on arrête`
    );

  // ── 4. Réseau hors des clous : abandon ───────────────────────────────────
  // Export : en mode 3 l'appareil n'absorbe QUE la consigne. Si le surplus
  // dépasse ce qu'on peut lui demander, le seul geste qui absorbe est de lui
  // rendre sa régulation — sans quoi on injecte indéfiniment en silence.
  if (piloting && inputs.gridW < -cfg.abortExportW && st.setpointW !== null) {
    const marge = -cfg.abortExportW - inputs.gridW; // > 0
    const place = Math.max(0, st.setpointW + Math.min(cfg.maxChargeW, roomW(inputs, cfg)));
    if (place < marge)
      return rendre(
        `injection ${Math.round(-inputs.gridW)} W que la consigne ne peut pas absorber — on rend la régulation à l'appareil`
      );
  }
  if (piloting && inputs.gridW > cfg.abortImportW) {
    st.importTicks += 1;
    if (st.importTicks >= cfg.abortTicks) {
      st.penaltyUntilTs = inputs.now + cfg.penaltyMs;
      const d = rendre(
        `ABANDON — import ${Math.round(inputs.gridW)} W sur ${st.importTicks} ticks`
      );
      return d;
    }
  } else if (inputs.gridW <= cfg.abortImportW) {
    st.importTicks = 0;
  }

  // ── 5. Régime normal ─────────────────────────────────────────────────────
  const plafond = Math.min(cfg.maxChargeW, roomW(inputs, cfg));

  // Entrée : on prend la barre SANS échelon — la consigne de départ est ce que
  // l'appareil faisait déjà de lui-même. Sinon il tombe à 0 W à la bascule
  // (mesuré le 13/09 : 670 W de charge → 0 W, 684 W partis au réseau).
  if (!piloting) {
    // On ne prend pas la barre sur un appareil qui DÉCHARGE (il couvre la
    // maison : lui commander une charge de 0 W la ferait acheter d'un coup),
    // ni pendant un achat déjà en cours.
    if (inputs.maxAcBattW > 50)
      return rendre(
        `la Max AC débite ${Math.round(inputs.maxAcBattW)} W pour la maison — on ne lui retire pas sa régulation`
      );
    if (inputs.gridW > cfg.deadbandW)
      return rendre(`achat de ${Math.round(inputs.gridW)} W en cours — on n'entre pas`);
    const chargeActuelleW = Math.max(0, -inputs.maxAcBattW);
    const depart = clamp(chargeActuelleW, 0, plafond);
    if (plafond < cfg.minChargeW)
      return rendre(`place trop faible (${Math.round(plafond)} W) — inutile de prendre la barre`);
    st.setpointW = -depart;
    st.lastWriteTs = inputs.now;
    st.lastProbeTs = inputs.now;
    return {
      mode: 'enter',
      writeW: -depart,
      targetW: -depart,
      reason: `prise de contrôle sans échelon — consigne de continuité ${Math.round(depart)} W (PV SB3 bridé à ${Math.round(inputs.sb3PvW)} W)`,
      nextState: st
    };
  }

  // Asservissement. `setpointW` est négatif (charge) ; une erreur compteur
  // POSITIVE (import) doit RÉDUIRE la charge, donc rapprocher la consigne de 0 —
  // c'est exactement `cur + gain * gridW` dans les deux sens.
  const cur = st.setpointW as number;
  const brut = cur + cfg.gain * inputs.gridW;
  const borne = clamp(brut, -plafond, 0);
  // Slew ASYMÉTRIQUE : il ne borne que la MONTÉE en charge (les SB3 mettent
  // 10-20 s à rouvrir leur PV, un échelon les laisserait derrière). Vers le bas,
  // l'erreur est MESURÉE et l'achat est interdit : on corrige tout de suite.
  const pas = clamp(borne - cur, -cfg.slewW, Number.POSITIVE_INFINITY);
  const cible = clamp(cur + pas, -plafond, 0);

  if (Math.abs(cible - cur) < cfg.deadbandW) {
    // EXPLORATION. À l'équilibre l'erreur est nulle : l'asservissement seul
    // resterait sur la charge spontanée et le PV des SB3 resterait bridé. On
    // pousse donc d'un palier tant que le réseau tient et qu'il reste de la
    // place. Si les SB3 ne suivent pas, l'import apparaît au tick suivant et
    // la branche d'asservissement redescend — c'est la recherche du maximum.
    // On ne sonde JAMAIS sur un import : le palier s'ajouterait à un achat déjà
    // en cours. Il faut le compteur à l'équilibre ou en surplus.
    const peutSonder =
      inputs.gridW <= 0 &&
      inputs.gridW >= -cfg.abortExportW &&
      cur > -plafond &&
      (st.lastProbeTs === null || inputs.now - st.lastProbeTs >= cfg.probeEveryMs);
    if (peutSonder) {
      const sonde = clamp(cur - cfg.probeStepW, -plafond, 0);
      if (Math.abs(sonde - cur) >= 1) {
        st.setpointW = sonde;
        st.lastWriteTs = inputs.now;
        st.lastProbeTs = inputs.now;
        return {
          mode: 'adjust',
          writeW: sonde,
          targetW: sonde,
          reason: `réseau à l'équilibre, PV SB3 ${Math.round(inputs.sb3PvW)} W — palier d'essai, charge ${Math.round(-cur)} → ${Math.round(-sonde)} W`,
          nextState: st
        };
      }
    }
    return {
      mode: 'hold',
      writeW: null,
      targetW: cur,
      reason: `réseau ${Math.round(inputs.gridW)} W, charge ${Math.round(-cur)} W — dans la bande morte`,
      nextState: st
    };
  }

  st.setpointW = cible;
  st.lastWriteTs = inputs.now;
  return {
    mode: 'adjust',
    writeW: cible,
    targetW: cible,
    reason:
      inputs.gridW > 0
        ? `import ${Math.round(inputs.gridW)} W — charge ${Math.round(-cur)} → ${Math.round(-cible)} W`
        : `surplus ${Math.round(-inputs.gridW)} W à récupérer — charge ${Math.round(-cur)} → ${Math.round(-cible)} W`,
    nextState: st
  };
}
