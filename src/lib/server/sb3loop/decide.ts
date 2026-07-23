/**
 * Loi de commande de la boucle SB3 — fonction PURE (testable sans réseau).
 *
 * Hiérarchie des règles (ordre d'évaluation strict) :
 *  1. FAIL-SAFE local : EM-50 ou Modbus Max AC muets → AUCUNE écriture (on ne
 *     sait rien du réel, on ne touche à rien).
 *  2. FAIL-LOW cloud : données cloud périmées → on ne connaît plus house_load ;
 *     si une consigne > 0 est en place, on la DESCEND d'un palier par cycle
 *     (une consigne haute figée = recyclage permanent ; basse = inoffensive).
 *  3. Garde SoC SB3 : sous le plancher, consigne 0 (le firmware coupe à ~10 %,
 *     inutile de demander l'impossible).
 *  4. RESCUE : Max AC sous son SoC minimal + SB3 chargées → la consigne suit la
 *     charge maison même de jour (on préserve la réserve de la Max AC).
 *  5. JOUR (soleil levé ET (APS produit OU SB3 pas pleines)) : consigne 0 —
 *     les SB3 chargent en DC, APS + Max AC servent la maison. Le passthrough à
 *     SOC 100 % n'est pas notre affaire (la consigne ne gouverne que la décharge).
 *  6. NUIT : consigne = clamp(house_load − marge, 0, max) — LÉGÈREMENT SOUS la
 *     charge : la Max AC couvre marge et pointes (asymétrie des coûts).
 *
 * Amortisseurs (appliqués à la cible) : slew ±slewW par cycle, bande morte
 * deadbandW tenue deadbandEvals évaluations, dwell (hausse dwellUpS, baisse
 * dwellDownS) entre écritures.
 */
import type { Sb3Decision, Sb3LoopConfig, Sb3LoopInputs, Sb3LoopState } from './types';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function decide(
  inputs: Sb3LoopInputs,
  cfg: Sb3LoopConfig,
  state: Sb3LoopState
): Sb3Decision {
  const noWrite = (
    mode: Sb3Decision['mode'],
    reason: string,
    houseLoadW: number | null = null,
    targetW: number | null = null,
    pendingDeadband = 0
  ): Sb3Decision => ({
    writeW: null,
    targetW,
    mode,
    reason,
    houseLoadW,
    pendingDeadband,
    pendingDeadbandDir: null
  });

  // Consigne « en place » de référence : la dernière écrite par la boucle,
  // sinon celle vue par le cloud (ancrage au premier cycle). CLAMPÉE : une
  // valeur cloud aberrante ne doit jamais servir d'ancre au slew.
  const rawCurrent = state.lastCmdW ?? inputs.cloud.sb3PresetW;
  const currentW = rawCurrent === null ? null : clamp(rawCurrent, 0, cfg.maxPresetW);

  // ── 1. Fail-safe local : sans les yeux, pas de mains. ──
  if (!inputs.em50.ok || !inputs.maxac.ok) {
    return noWrite(
      'failsafe',
      !inputs.em50.ok ? 'EM-50 muet — aucune écriture' : 'Modbus Max AC muet — aucune écriture'
    );
  }

  // ── 2. Fail-low : cloud périmé → décroître d'un palier par cycle. ──
  const cloudFresh =
    inputs.cloud.ok && inputs.cloud.freshS !== null && inputs.cloud.freshS <= cfg.cloudStaleS;
  if (!cloudFresh) {
    if (currentW !== null && currentW > 0) {
      const step = Math.max(0, currentW - cfg.slewW);
      // Dwell dédié (failLowDwellS) : un palier toutes les 5 min, pas un login
      // cloud par minute — la descente complète 2400 → 0 prend ~40 min.
      const can =
        state.lastWriteTs === null || inputs.now - state.lastWriteTs >= cfg.failLowDwellS * 1000;
      return {
        writeW: can ? step : null,
        targetW: step,
        mode: 'faillow',
        reason: `cloud périmé — décroissance ${currentW} → ${step} W`,
        houseLoadW: null,
        pendingDeadband: 0,
        pendingDeadbandDir: null
      };
    }
    return noWrite('faillow', 'cloud périmé — consigne déjà basse, rien à faire');
  }

  // Le plan personnalisé doit être le mode actif, sinon nos écritures ne
  // gouvernent rien (informational : on attend, on ne désactive pas).
  if (inputs.cloud.sceneMode !== 3) {
    return noWrite('hold', `mode Anker ${inputs.cloud.sceneMode} ≠ manuel — écritures suspendues`);
  }

  const sb3Soc = inputs.cloud.sb3SocAvg;
  // Après une écriture, le sb3Out CLOUD traîne 1-3 min derrière la réalité
  // (le device applique en secondes) : pendant settleS on lui substitue la
  // consigne écrite — sinon la boucle chasse son propre retard (cycle limite).
  const settling =
    state.lastWriteTs !== null &&
    state.lastCmdW !== null &&
    inputs.now - state.lastWriteTs < cfg.settleS * 1000;
  const sb3Out = settling ? (state.lastCmdW as number) : (inputs.cloud.sb3OutW ?? 0);

  // house_load : import réseau + APS + sortie SB3 + flux AC net Max AC SIGNÉ.
  // Le SIGNE est vital (revue 23/07) : en régime de recyclage (consigne > charge
  // réelle, la Max AC absorbe l'excédent à compteur nul), sa CHARGE −(C−H)
  // annule l'excès compté dans sb3Out et l'estimation redonne H — sans le
  // signe, l'estimation dégénérait en « consigne + APS » et toute consigne trop
  // haute s'auto-confirmait (figement/emballement).
  const houseLoadW = Math.max(
    0,
    Math.round(inputs.em50.gridW + inputs.aps.powerW + sb3Out + inputs.maxac.acNetW)
  );

  // ── 3. Garde plancher SB3. ──
  if (sb3Soc !== null && sb3Soc < cfg.sb3FloorPct) {
    return applyTarget(0, 'day', `SB3 à ${Math.round(sb3Soc)} % — plancher, consigne 0`);
  }

  // ── 4. Rescue : préserver la Max AC — SEULEMENT si elle se vide RÉELLEMENT.
  // Incident 23/07 : rescue ne regardait que le SoC → il s'est déclenché tout
  // un matin ensoleillé alors que la Max AC (basse mais EN CHARGE, acNet < 0)
  // n'était pas en danger, drainant les SB3 jusqu'à 10 % au lieu de les laisser
  // charger. Le vrai signal de détresse = la Max AC DÉCHARGE (acNet > seuil)
  // ET reste basse ET les SB3 ont du stock à céder. Une Max AC en charge ou au
  // repos ne déclenche jamais de rescue → pas de vol de la recharge diurne. ──
  const rescue =
    inputs.maxac.socPct < cfg.maxAcMinPct &&
    inputs.maxac.acNetW > cfg.rescueMaxAcDischargeW &&
    sb3Soc !== null &&
    sb3Soc > cfg.rescueSb3MinPct;

  // ── 5/6. Jour / nuit par éphémérides + production réelle. APS injoignable
  // en plein soleil (panne ≠ nuit) → on reste conservateur côté « jour »
  // (consigne 0, les SB3 chargent) plutôt que de les vider à midi. ──
  const sunUp = inputs.sunElevDeg > 0;
  const isDay =
    sunUp &&
    (!inputs.aps.ok ||
      inputs.aps.powerW > cfg.dayApsW ||
      (sb3Soc !== null && sb3Soc < cfg.daySocPct));

  if (isDay && !rescue) {
    return applyTarget(0, 'day', 'jour — les SB3 chargent, consigne 0');
  }

  const mode = rescue ? 'rescue' : 'night';
  const targetRaw = clamp(houseLoadW - cfg.marginW, 0, cfg.maxPresetW);
  return applyTarget(
    targetRaw,
    mode,
    rescue
      ? `rescue — Max AC ${Math.round(inputs.maxac.socPct)} % < ${cfg.maxAcMinPct} %, la consigne suit la charge`
      : `nuit — charge maison ${houseLoadW} W, cible ${targetRaw} W (marge ${cfg.marginW} W)`
  );

  /** Applique slew, bande morte (2 évaluations) et dwell à une cible brute. */
  function applyTarget(rawW: number, m: Sb3Decision['mode'], reason: string): Sb3Decision {
    // Slew depuis la consigne en place (ancrage cloud au premier cycle).
    const anchor = currentW ?? 0;
    const slewed = Math.round(clamp(rawW, anchor - cfg.slewW, anchor + cfg.slewW));

    // Bande morte sur la consigne EN PLACE : ne pas s'agiter pour < deadbandW.
    if (currentW !== null && Math.abs(slewed - currentW) <= cfg.deadbandW) {
      return {
        writeW: null,
        targetW: slewed,
        mode: m,
        reason: `${reason} — dans la bande morte`,
        houseLoadW,
        pendingDeadband: 0,
        pendingDeadbandDir: null
      };
    }
    // Compteur DIRECTIONNEL : une excursion haute suivie d'une basse ne doit
    // pas totaliser 2 — un changement de direction repart à 1 (revue 23/07).
    const dir: 'up' | 'down' = currentW !== null && slewed < currentW ? 'down' : 'up';
    const pending = state.pendingDeadbandDir === dir ? state.pendingDeadband + 1 : 1;
    if (pending < cfg.deadbandEvals) {
      return {
        writeW: null,
        targetW: slewed,
        mode: m,
        reason: `${reason} — hors bande (${pending}/${cfg.deadbandEvals})`,
        houseLoadW,
        pendingDeadband: pending,
        pendingDeadbandDir: dir
      };
    }

    // Dwell : hausses patientes, baisses plus réactives (jamais < dwellDownS).
    const down = currentW !== null && slewed < currentW;
    if (!canWrite(inputs.now, state, cfg, down)) {
      return {
        writeW: null,
        targetW: slewed,
        mode: m,
        reason: `${reason} — dwell en cours`,
        houseLoadW,
        pendingDeadband: pending,
        pendingDeadbandDir: dir
      };
    }
    return {
      writeW: slewed,
      targetW: slewed,
      mode: m,
      reason,
      houseLoadW,
      pendingDeadband: 0,
      pendingDeadbandDir: null
    };
  }
}

function canWrite(now: number, state: Sb3LoopState, cfg: Sb3LoopConfig, down: boolean): boolean {
  if (state.lastWriteTs === null) return true;
  const dwellS = down ? cfg.dwellDownS : cfg.dwellUpS;
  return now - state.lastWriteTs >= dwellS * 1000;
}
