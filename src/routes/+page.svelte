<script lang="ts" module>
  // La cascade d'entrée (.stagger-enter) ne doit jouer qu'UNE fois par
  // chargement : le layout détruit la page hydratée pour la remonter dans le
  // Pager (cf. +layout.svelte) — sans ce verrou, les cartes déjà apparues
  // disparaissaient toutes puis rejouaient la cascade (~0,85 s) à chaque
  // lancement. État de MODULE : il survit au remontage, pas au rechargement.
  let staggerPlayed = false;
</script>

<script lang="ts">
  import { browser } from '$app/environment';
  import FlowDiagram from '$components/charts/FlowDiagram.svelte';
  import SavingsCard from '$components/cards/SavingsCard.svelte';
  import { anker } from '$stores/anker.svelte';
  import { ankerLocal } from '$stores/ankerLocal.svelte';
  import { production } from '$stores/production.svelte';
  import { savings } from '$stores/savings.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { apsystems } from '$stores/apsystems.svelte';
  import { health } from '$stores/health.svelte';
  import { clock } from '$stores/clock.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { pagerNav } from '$lib/pager/pager-nav.svelte';
  import { sb3loop } from '$stores/sb3loop.svelte';
  import { acquire } from '$stores/refcount';
  import { Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { onMount, onDestroy } from 'svelte';

  // SSR : toujours la cascade (le HTML doit l'embarquer pour qu'elle démarre au
  // premier paint, avant l'hydratation). Client : seule la PREMIÈRE instance la
  // garde ; le remontage par le Pager reprend le contenu déjà visible tel quel.
  const staggerEnter = !browser || !staggerPlayed;
  if (browser) staggerPlayed = true;

  // ─── Sources : mesures réelles uniquement ────────────────────────────
  // Tout en watts, signed (+ import / − export).
  // Solaire séparé par pan (installation Sanguinet) :
  //   • Sud   = onduleur APS (EZ1) + SolarBank 1 (alias *-1)
  //   • Ouest = SolarBank 2 (alias *-2)
  // Répartition agrégée robuste : anker.sb1SolarW/sb2SolarW = solar_power_w (agrégat
  // FIABLE) ventilé par le dernier ratio par-unité connu (les champs par-unité sont
  // intermittents). Purement AFFICHAGE : n'entre JAMAIS dans le calcul d'économies
  // (recorder serveur, 100 % AC).
  // Plus AUCUN repli inventé : `dashboard.solarPower` était une courbe fabriquée
  // à partir de l'heure, animée toutes les 3 s par demo-ticker. Elle peignait une
  // production plausible ET MOUVANTE alors que rien ne répondait — la nuit
  // comprise — et écrasait au passage la mesure APS locale, elle bien vivante
  // (l'onduleur EZ1 est lu sur le LAN et survit très bien à une panne du cloud
  // Solix). Ce qui n'est pas mesuré n'est plus peint.
  // APS « mort » ⇒ 0 : un 0 W muet serait indiscernable d'une nuit, donc le nœud
  // disparaît du Sankey (FlowDiagram retire les nœuds à 0) et la mention passe
  // par `sourcesMuettes` sous la carte.
  const apsMesure = $derived(apsystems.etat !== 'mort');
  const pvSudW = $derived(
    (apsMesure ? production.apsW : 0) + (anker.connected ? anker.sb1SolarW : 0)
  );
  const pvOuestW = $derived(anker.connected ? anker.sb2SolarW : 0);
  // Réseau FIABLE — PRIORITÉ à l'EM-50 (compteur local Shelly : mesure instantanée
  // signée, recoupée Anker à ±10 W — la raison d'être de son intégration). 1er repli :
  // le Smart Meter Gen 2 lu en Modbus LOCAL (même convention de signe, vérifiée ;
  // instantané, sans cloud). 2e repli : le dérivé Linky d'Anker (fiable mais lent,
  // ~5 min) ; le grid_power_w INSTANTANÉ du cloud Solix, lui, reste inexploitable
  // (paliers figés, signe instable, fantômes). Plus de mock en dernier recours :
  // `shelly.gridPowerW` fabriquait un import/export à partir d'une courbe horaire
  // + un bruit de ±90 W, recalculé toutes les 3 s — donc cohérent avec l'heure,
  // donc parfaitement crédible. Et « Maison » se déduisant du réseau, la conso de
  // la maison était fausse elle aussi.
  const gridPowerW = $derived(
    em50.available
      ? em50.gridPowerW
      : ankerLocal.meterAvailable
        ? ankerLocal.meterGridPowerW
        : anker.connected
          ? anker.gridReliableW
          : 0
  );
  /** Le réseau vient-il d'un compteur RÉEL ? Sinon on l'annonce, on ne le peint pas. */
  const gridMesure = $derived(em50.available || ankerLocal.meterAvailable || anker.connected);
  /** Conso du chauffe-eau, gardée par la disponibilité du compteur. Non gardée,
   *  un EM-50 mort pendant une chauffe figeait « ≈ 2 900 W » indéfiniment — et
   *  comme ce terme ferme le bilan, la conso « Maison » était fausse elle aussi. */
  const cumulusW = $derived(em50.available ? em50.cumulusPowerW : 0);
  /**
   * Délai de grâce avant d'annoncer quoi que ce soit — même principe que le
   * bandeau `health` (GRACE_MS). Au rendu serveur et juste après l'hydratation,
   * AUCUN store n'a encore répondu : sans cette garde, chaque chargement de page
   * afficherait un « sans réponse » fugace, c'est-à-dire une fausse alerte à
   * chaque ouverture de l'app. Calibré sur la source la plus lente : Anker poll
   * à 15 s avec 15 s de timeout.
   */
  const ANNONCE_GRACE_MS = 35_000;
  let monteA = $state<number | null>(null);
  onMount(() => {
    monteA = Date.now();
  });

  /**
   * Ce qu'on NE mesure plus, dit en français. Le bandeau global (HealthBanner)
   * annonce déjà « toute la maison est injoignable » : quand il parle, on se tait,
   * sinon dix cartes crient la même panne sous un bandeau qui la dit déjà.
   */
  const sourcesMuettes = $derived.by((): string[] => {
    if (health.linkDown) return [];
    if (monteA === null || clock.now - monteA < ANNONCE_GRACE_MS) return [];
    const out: string[] = [];
    if (!gridMesure) out.push('Compteur électrique sans réponse');
    if (!apsMesure) out.push('Panneaux du toit sans réponse');
    if (!batteryOnline) out.push('Batteries sans réponse');
    return out;
  });
  // ─── Batterie : fusion cloud + LOCAL (Modbus Max AC) ─────────────────────
  // Depuis la reconfiguration des systèmes Anker (22/07), le bridge cloud
  // liste les TROIS batteries dans batteries[] — Max AC (A17E2) comprise.
  // Quand la lecture Modbus locale est up, elle PRIME pour la Max AC
  // (fraîcheur 2,5 s ici vs ~60 s cloud) : on DÉDUPLIQUE donc l'entrée cloud
  // A17E2 pour ne pas compter la Max AC deux fois (SoC pondéré, flux, stock).
  //   SoC parc = pondéré par CAPACITÉ (SB3 cloud + Max AC locale) ;
  //   flux = per-unit SB3 cloud + Max AC locale temps réel.
  // Repli intégral sur le cloud (désormais complet) si le local est
  // injoignable, et sur le local seul si le cloud est down.
  const localBatteryUp = $derived(ankerLocal.sbAvailable && ankerLocal.ratedEnergyWh > 0);
  const batteryOnline = $derived(anker.connected || localBatteryUp);
  /** Batteries cloud SANS la Max AC (A17E2) — sa vérité vient du Modbus local. */
  const cloudSb3 = $derived(anker.batteries.filter((b) => b.model !== 'A17E2'));
  const batterySoc = $derived.by(() => {
    if (anker.connected && localBatteryUp) {
      const num =
        cloudSb3.reduce((s, b) => s + b.soc * b.capacityWh, 0) +
        ankerLocal.socPct * ankerLocal.ratedEnergyWh;
      const den = cloudSb3.reduce((s, b) => s + b.capacityWh, 0) + ankerLocal.ratedEnergyWh;
      return den > 0 ? num / den : ankerLocal.socPct;
    }
    if (localBatteryUp) return ankerLocal.socPct;
    // Aucune source batterie : 0, et non plus une valeur fictive. L'affichage est
    // déjà gardé par `batteryOnline`, mais la valeur inventée circulait quand même
    // (tweenée puis passée au Sankey) — bombe amorcée pour le premier qui
    // l'afficherait sans garde.
    return anker.connected ? (anker.averageSoc ?? 0) : 0;
  });
  // ── Flux des SB3 RECONSTRUITS par bilan physique (les champs cloud sont CASSÉS) ──
  // `charging_power_w` / `discharging_power_w` par unité valent ≈ TOUJOURS 0 côté cloud.
  // Conséquence mesurée (25/07) : la charge des SB3 devenait INVISIBLE dans le bilan, et
  // « Maison » — calculée en résidu — absorbait tout le solaire parti en batterie : jusqu'à
  // ~1,5 kW fantômes en journée (maison affichée 1488 W alors que la vraie veille est
  // ~230 W), et 0 W la nuit alors qu'elle tire ~230 W.
  // On dérive donc le flux de chaque SolarBank de son bilan physique, sur des champs
  // FIABLES : net = PV entrant (DC) − sortie AC.  net > 0 → charge ; net < 0 → décharge.
  // (Vérifié sur 3 instants réels : 233 / 188 / 229 W de veille au lieu de 1488 / 617 / 0.)
  /** PV DC entrant par SB3 (W). Le per-unité cloud est intermittent → repli sur l'agrégat
   *  `solarPowerW` (fiable) ventilé par le dernier ratio Sud/Ouest connu du store. */
  const sb3PvInW = $derived.by((): number[] => {
    const perUnit = cloudSb3.map((b) => Math.max(0, b.inputPowerW));
    if (perUnit.reduce((s, v) => s + v, 0) > 1) return perUnit;
    const agg = Math.max(0, anker.solarPowerW);
    if (agg <= 1) return cloudSb3.map(() => 0);
    // Convention du store : sb1SolarW ↔ 1re unité, sb2SolarW ↔ 2e (cf. anker.svelte.ts).
    if (cloudSb3.length === 2) return [anker.sb1SolarW, anker.sb2SolarW];
    return cloudSb3.map(() => agg / Math.max(1, cloudSb3.length));
  });
  /**
   * Net BRUT par SB3 : PV DC entrant − sortie AC. C'est une DIFFÉRENCE de deux champs
   * du même snapshot cloud qui ne se rafraîchissent pas ensemble — un décalage d'un
   * cran suffit à fabriquer un flux qui n'existe pas.
   * Mesuré (27/07, 112 échantillons, packs PLEINS et SoC figé à 100,0 %) : le net
   * oscillait autour de **−2 W** avec des excursions à ±47 W… pendant que l'app
   * annonçait « SB3 Ouest · décharge 68 W » et « DÉCHARGE −68 W » sur une batterie
   * dont le SoC ne bougeait pas d'un pouce. Un flux instantané reconstruit par
   * différence ne doit donc pas être AFFIRMÉ tel quel.
   */
  const sb3NetRaw = $derived(
    cloudSb3.map((b, i) => (sb3PvInW[i] ?? 0) - Math.max(0, b.outputPowerW))
  );
  /**
   * CONFIRMATION sur deux snapshots cloud distincts — même discipline que le filtre
   * anti-fantôme du recorder. Un vrai flux PERSISTE (et garde son signe) ; le bruit
   * d'échantillonnage change de signe d'un snapshot à l'autre. On retient donc la
   * valeur de plus PETITE amplitude quand les deux s'accordent, et zéro quand ils se
   * contredisent. Auto-calibré : aucun seuil inventé, et la vraie décharge du soir
   * (plusieurs centaines de watts, stable) passe intacte.
   */
  let prevNet = $state<number[]>([]); // net du snapshot PRÉCÉDENT
  let lastNet: number[] = []; // net du snapshot courant (ombre non réactive)
  let lastSnapTs: number | null = null;
  $effect(() => {
    const ts = anker.snapshotTs;
    const cur = sb3NetRaw;
    if (ts && ts !== lastSnapTs) {
      prevNet = lastNet;
      lastNet = cur;
      lastSnapTs = ts;
    }
  });
  /** Net RETENU : brut au tout premier snapshot (rien à comparer), confirmé ensuite. */
  const sb3Net = $derived(
    sb3NetRaw.map((raw, i) => {
      const prev = prevNet[i];
      if (prev === undefined) return raw;
      if (Math.sign(raw) !== Math.sign(prev)) return 0;
      return Math.sign(raw) * Math.min(Math.abs(raw), Math.abs(prev));
    })
  );

  /**
   * Sortie AC FRAÎCHE du système SB3 : la consigne que la sb3loop vient d'écrire.
   * Les sorties cloud accusent un snapshot ~60 s + la confirmation 2 snapshots
   * ci-dessus (jusqu'à 2-3 min de retard) : après un échelon de charge
   * (extinction du cumulus, −2,3 kW d'un coup), le résidu « Maison » avalait
   * l'écart entre l'ancien monde cloud et les mesures fraîches — ~900 W
   * fantômes constatés le 01/08. Or la boucle CONNAÎT la sortie qu'elle impose
   * (écriture < 20 s, confirmée ±25 W par relecture du schedule, bail bridge en
   * cas de mort) — son `settle` interne substitue déjà la consigne au sb3Out
   * cloud, on étend le même principe à l'affichage. En vigueur ⟺ boucle
   * active ET tick vivant ET `lastCmdW` non nul (l'engine le repose à null
   * quand le plan statique est restauré : plus aucune consigne ne s'applique).
   * `clock.now` (10 s) garde la condition vivante même si le poll du store gèle.
   */
  const SB3LOOP_TICK_STALE_MS = 180_000; // aligné sur tickAlive du store
  const sb3CmdOutW = $derived.by((): number | null => {
    if (!sb3loop.connected || !sb3loop.enabled) return null;
    const tick = sb3loop.lastTickTs;
    if (tick === null || clock.now - tick > SB3LOOP_TICK_STALE_MS) return null;
    return sb3loop.lastCmdW;
  });

  /** Horizon d'absorption : un pack ne peut encaisser que la PLACE qui lui reste.
   *  Un pack à 99 % (27 Wh de place) ne peut pas absorber 372 W — il passe en AC. */
  const SB3_FILL_HORIZON_H = 0.25;
  /** Veille incompressible de la maison (box + VMC + RPi4…), mesurée ~230 W la nuit.
   *  Plancher volontairement CONSERVATEUR : sert de contrainte de fermeture, pas de valeur. */
  const HOUSE_FLOOR_W = 120;

  /**
   * Flux batterie (W) — SB3 reconstruits, Max AC mesurée, puis FERMETURE du bilan.
   * La conso Maison n'est mesurée nulle part (l'EM-50 ne voit que réseau + cumulus) :
   * elle est forcément déduite. Elle n'est donc juste que si TOUS les autres flux le
   * sont — or la sortie AC des SB3 est la seule grandeur ni mesurée ni fiable côté
   * cloud (SAUF quand la consigne sb3loop est en vigueur : voie fraîche ci-dessus).
   * On la traite comme l'inconnue, en l'encadrant par deux contraintes
   * PHYSIQUES au lieu de laisser l'erreur s'écraser sur la Maison :
   *   1. un pack ne peut pas absorber plus que sa place restante (sinon il sort en AC) ;
   *   2. la Maison ne peut pas descendre sous sa veille incompressible.
   * Tout écart résiduel est réattribué à la charge SB3 (l'inconnue), jamais à la Maison.
   */
  const battFlow = $derived.by((): { charge: number; discharge: number; perPack: number[] } => {
    if (!localBatteryUp) {
      // Repli DÉGRADÉ (Modbus Max AC injoignable) : agrégats cloud, eux aussi peu fiables.
      if (anker.connected)
        return { charge: anker.batteryChargeW, discharge: anker.batteryDischargeW, perPack: [] };
      // Plus AUCUNE source batterie : ne rien peindre. C'étaient deux constantes
      // arbitraires (400 W de charge ou 600 W de décharge) — le Sankey affichait
      // donc « Batterie · charge 400 W » pendant que la carte Batterie juste
      // au-dessus affichait « — » et « Hors ligne ». Deux affirmations
      // contradictoires sur le même écran, et c'est la fausse qui avait l'air
      // vivante. À 0, le nœud disparaît du Sankey.
      return { charge: 0, discharge: 0, perPack: [] };
    }
    // (a) net par SB3 : PV DC entrant − sortie AC. Sortie = consigne sb3loop quand
    // elle est en vigueur — fraîche par construction, ventilée au prorata du PV de
    // chaque pack (répartition interne Anker vérifiée en réel le 01/08 : sorties
    // 846/687 W pour PV 955/796 W, mêmes ratios), à parts égales la nuit (PV nul).
    // Le PV cloud reste utilisable même périmé : le soleil ne fait pas d'échelon.
    // Sinon : sorties cloud CONFIRMÉES sur deux snapshots. En régime établi les
    // deux voies coïncident (consigne confirmée ±25 W) : aucune marche à la bascule.
    let net: number[];
    if (sb3CmdOutW === null) {
      net = sb3Net;
    } else {
      const cmd = sb3CmdOutW;
      const pvTot = sb3PvInW.reduce((s, v) => s + v, 0);
      net = sb3PvInW.map(
        (pv) => pv - cmd * (pvTot > 1 ? pv / pvTot : 1 / Math.max(1, sb3PvInW.length))
      );
    }
    // (b) contrainte 1 — plafond d'absorption par la place restante du pack.
    const perPack = net.map((n, i) => {
      if (n <= 0) return n;
      const b = cloudSb3[i];
      const roomWh = Math.max(0, b.capacityWh * (1 - Math.min(1, Math.max(0, b.soc) / 100)));
      return Math.min(n, roomWh / SB3_FILL_HORIZON_H);
    });
    const maxAcCharge = Math.max(0, -ankerLocal.batteryPowerW);
    const maxAcDischarge = Math.max(0, ankerLocal.batteryPowerW);
    let sb3Charge = perPack.reduce((s, n) => s + Math.max(0, n), 0);
    const discharge = perPack.reduce((s, n) => s + Math.max(0, -n), 0) + maxAcDischarge;
    // (c) contrainte 2 — fermeture : si la Maison déduite passe sous la veille, c'est
    // que la charge SB3 est surestimée (le pack sortait en AC) → on la réduit d'autant.
    const home = pvSudW + pvOuestW + gridPowerW - (sb3Charge + maxAcCharge - discharge) - cumulusW;
    if (home < HOUSE_FLOOR_W && sb3Charge > 0) {
      const cut = Math.min(sb3Charge, HOUSE_FLOOR_W - home);
      const k = (sb3Charge - cut) / sb3Charge;
      for (let i = 0; i < perPack.length; i++) if (perPack[i] > 0) perPack[i] *= k;
      sb3Charge -= cut;
    }
    return { charge: sb3Charge + maxAcCharge, discharge, perPack };
  });

  // Charge (→ usage) et décharge (→ apport) SÉPARÉES. Le Sankey peut ainsi
  // montrer la batterie du bon côté (voire les deux).
  const batteryChargeW = $derived(battFlow.charge);
  const batteryDischargeW = $derived(battFlow.discharge);

  // Détail PAR PACK : les 2 Solarbank 3 (cloud, hors A17E2) + la Max AC (Modbus local
  // prioritaire, sinon repli cloud). Sert à ÉCLATER le nœud Batterie du Sankey ET à la
  // carte Charge. SoC = donnée fiable ; charge/décharge = best-effort (indicateur).
  interface BatteryDetail {
    label: string;
    soc: number;
    chargeW: number;
    dischargeW: number;
  }
  // Orientation des 2 SolarBank 3 par NUMÉRO DE SÉRIE : le cloud les nomme à l'identique
  // (« Solarbank 3 E2700 Pro ») et n'expose ni orientation ni PV par-unité. Mapping donné
  // par Laurent (24/07) : …635 = pan SUD, …062 = pan OUEST. Repli SB3-1/2 si SN inconnu
  // (unité remplacée). Préfixe « SB3 » pour ne pas confondre avec les nœuds solaires Sud/Ouest.
  const SB3_ORIENTATION: Record<string, string> = {
    APCDJES0F15200635: 'SB3 Sud',
    APCDJES0F15700062: 'SB3 Ouest'
  };
  const batteryDetail = $derived.by((): BatteryDetail[] => {
    const out: BatteryDetail[] = [];
    // Flux SB3 : bilan physique borné (cf. battFlow), PAS les champs cloud cassés qui
    // affichaient « — » (repos) alors que les packs chargeaient à plus d'1 kW.
    cloudSb3.forEach((b, i) =>
      out.push({
        label: SB3_ORIENTATION[b.id] ?? `SB3-${i + 1}`,
        soc: b.soc,
        chargeW: Math.max(0, battFlow.perPack[i] ?? 0),
        dischargeW: Math.max(0, -(battFlow.perPack[i] ?? 0))
      })
    );
    if (localBatteryUp) {
      out.push({
        label: 'Max AC',
        soc: ankerLocal.socPct,
        chargeW: Math.max(0, -ankerLocal.batteryPowerW),
        dischargeW: Math.max(0, ankerLocal.batteryPowerW)
      });
    } else {
      const max = anker.batteries.find((b) => b.model === 'A17E2');
      if (max)
        out.push({
          label: 'Max AC',
          soc: max.soc,
          chargeW: Math.max(0, max.chargingPowerW),
          dischargeW: Math.max(0, max.dischargingPowerW)
        });
    }
    return out;
  });

  // ─── Transitions d'affichage ─────────────────────────────────────────
  // On interpole les puissances entre deux relevés (Anker rafraîchit ~toutes les
  // 15 s) → les rubans du Sankey et les compteurs GLISSENT au lieu de sauter, ce
  // qui rend chaque mise à jour perceptible. Durée 0 si l'utilisateur a coupé les
  // animations (Réglages) ou si l'OS réclame un mouvement réduit.
  let reducedMotion = $state(false);
  $effect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const on = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  const animMs = $derived(preferences.animationsEnabled && !reducedMotion ? 600 : 0);

  const pvSudTw = new Tween(0, { easing: cubicOut });
  const pvOuestTw = new Tween(0, { easing: cubicOut });
  const gridTw = new Tween(0, { easing: cubicOut });
  const batChargeTw = new Tween(0, { easing: cubicOut });
  const batDischargeTw = new Tween(0, { easing: cubicOut });
  const socTw = new Tween(0, { easing: cubicOut });
  $effect(() => void pvSudTw.set(pvSudW, { duration: animMs, easing: cubicOut }));
  $effect(() => void pvOuestTw.set(pvOuestW, { duration: animMs, easing: cubicOut }));
  $effect(() => void gridTw.set(gridPowerW, { duration: animMs, easing: cubicOut }));
  $effect(() => void batChargeTw.set(batteryChargeW, { duration: animMs, easing: cubicOut }));
  $effect(() => void batDischargeTw.set(batteryDischargeW, { duration: animMs, easing: cubicOut }));
  $effect(() => void socTw.set(batterySoc, { duration: animMs, easing: cubicOut }));

  // Valeurs ANIMÉES consommées par le Sankey + le hero.
  const pvSudA = $derived(pvSudTw.current);
  const pvOuestA = $derived(pvOuestTw.current);
  const pvA = $derived(pvSudA + pvOuestA); // total animé (bilan Maison)
  const gridA = $derived(gridTw.current);
  const batChargeA = $derived(batChargeTw.current);
  const batDischargeA = $derived(batDischargeTw.current);
  const batA = $derived(batChargeA - batDischargeA); // net (pour le bilan Maison)
  const socA = $derived(socTw.current);
  // Maison = PV + réseau net − batterie nette. Le réseau (gridA) est désormais la
  // mesure Linky FIABLE, donc le bilan se referme correctement sans terme correctif.
  // Équilibre instantané ; pertes de conversion < 5 % ignorées.
  const homeA = $derived(Math.max(0, Math.round(pvA + gridA - batA)));

  // ─── Boost de réactivité local (fraîcheur du Sankey) ─────────────────────────
  // Le réseau EDF est le signal LOCAL le plus fiable et le plus actionnable quand on
  // jongle avec les appareils → il alimente le Sankey apports/usages en temps réel.
  // On accélère em50/aps (2,5 s / 5 s) SEULEMENT quand l'accueil est la page
  // CENTRALE du pager (pagerNav.current==='/' ; null = 1er paint hors pager = accueil)
  // → pas de poll rapide en arrière-plan sur les autres pages. Anker JAMAIS boosté
  // (mur cloud Solix ~60 s + risque de ban).
  const homePageActive = $derived(pagerNav.current === null || pagerNav.current === '/');
  $effect(() => {
    if (homePageActive) {
      em50.setBoost(2500);
      apsystems.setBoost(5000);
      ankerLocal.setBoost(2500); // Max AC + Gen 2 en Modbus LAN : boost sans risque
    } else {
      em50.clearBoost();
      apsystems.clearBoost();
      ankerLocal.clearBoost();
    }
  });
  // sb3loop via refcount : /energie l'acquiert aussi — le pager monte les deux
  // pages en même temps, un connect/disconnect binaire couperait l'autre.
  let releaseSb3loop: (() => void) | null = null;
  onMount(() => {
    releaseSb3loop = acquire(sb3loop);
  });
  onDestroy(() => {
    em50.clearBoost();
    apsystems.clearBoost();
    ankerLocal.clearBoost();
    releaseSb3loop?.();
    releaseSb3loop = null;
  });
  // ─── Fraîcheur de la part « batterie » de la conso (cloud Solix ~60 s) ───────
  // La conso Maison mêle réseau (frais) et part SolarBank (cloud). Le snapshot Anker
  // avance ~toutes les 60 s ; figé > 75 s ⇒ pastille ambre sur le nœud Maison (sinon
  // verte). Tick visibility-aware : pas de timer fantôme en arrière-plan (PWA).
  let nowMs = $state(Date.now());
  $effect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => void (id ??= setInterval(() => (nowMs = Date.now()), 1000));
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        nowMs = Date.now();
        start();
      } else stop();
    };
    document.addEventListener('visibilitychange', onVis);
    start();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  });
  const ANKER_STALE_MS = 75_000;
  const homeConfidence = $derived.by<'live' | 'cloud-lag'>(() =>
    anker.connected && anker.snapshotTs && nowMs - anker.snapshotTs * 1000 > ANKER_STALE_MS
      ? 'cloud-lag'
      : 'live'
  );

  // ─── Énergie UTILE en batterie (kWh) — pour la carte Batterie ─────────
  // Ce qu'on peut réellement sortir des packs, RÉSERVE DÉDUITE — et non le
  // contenu brut. Un parc à 15 % n'offre pas 15 % de son énergie : les Solarbank
  // s'arrêtent à leur réserve, le reste ne sortira jamais. Afficher le brut, c'est
  // promettre des kWh qui n'arriveront pas.
  //
  // Formule ALIGNÉE sur la source de vérité du pilotage — `usableWh()` de
  // `src/lib/server/sb3loop/decide.ts`, qui répartit charge et décharge au prorata
  // des kWh utilisables : utile = capacité × (SoC − réserve) / 100, borné à 0.
  // Elle est recopiée (et non importée) parce que `$lib/server` ne peut pas partir
  // au navigateur. Si la réserve change côté boucle, la changer ici aussi.
  const RESERVE_PCT = 10; // = Sb3LoopConfig.reservePct par défaut
  const usableWhOf = (socPct: number, capacityWh: number): number =>
    !Number.isFinite(socPct) || !Number.isFinite(capacityWh) || capacityWh <= 0
      ? 0
      : Math.max(0, capacityWh * (Math.min(100, Math.max(0, socPct)) - RESERVE_PCT)) / 100;

  // Local up : SB3 cloud (sans l'entrée Max AC, dédupliquée) + Max AC locale.
  // Local down : les batteries du cloud, qui incluent désormais la Max AC.
  const usableKwh = $derived.by(() => {
    const packs = localBatteryUp
      ? [
          ...cloudSb3.map((b) => ({ soc: b.soc, cap: b.capacityWh })),
          { soc: ankerLocal.socPct, cap: ankerLocal.ratedEnergyWh }
        ]
      : anker.batteries.map((b) => ({ soc: b.soc, cap: b.capacityWh }));
    return packs.reduce((sum, p) => sum + usableWhOf(p.soc, p.cap), 0) / 1000;
  });

  // ─── Bilan énergie du JOUR — répartition de toute l'énergie brassée ──────
  // 3 parts d'un même total (= 100 %) : solaire autoconsommé + surplus renvoyé
  // à EDF (production) + soutirage réseau (import). Le surplus EST de l'énergie
  // produite → il compte dans le pourcentage.
  // Sources : auto & import = recorder (savings) ; surplus = cumul Linky du
  // bridge Anker (le recorder sous-estime le surplus faible).
  const solarSelfKwh = $derived(savings.today.kwh); // solaire consommé sur place
  const gridImportKwh = $derived(savings.today.import_kwh); // soutiré à EDF (EM-50)
  /** Injection du jour — intégrale du compteur LOCAL EM-50 ; `null` = NON MESURÉE.
   *  L'ancienne source (compteur cloud Anker) est muette depuis la reconfiguration
   *  des systèmes, et l'app peignait ce silence en « Surplus 0,0 % » — un zéro
   *  affirmé comme une mesure, sous un Sankey qui annonçait 969 W d'injection. */
  const gridExportKwh = $derived(savings.today.export_kwh);
  /** Consommation du jour = ce qui est ENTRÉ dans la maison. L'injection est SORTIE :
   *  la mettre au dénominateur gonflait le total et écrasait les autres parts. */
  const energyTotalKwh = $derived(solarSelfKwh + gridImportKwh);
  // `savings.connected` en plus du seuil : sans lui, la barre restait affichée
  // avec les pourcentages FIGÉS du dernier relevé, indéfiniment — pendant que la
  // carte Économies juste au-dessus affichait « — ». Deux cartes voisines, deux
  // comportements opposés sur la même source morte.
  const flowsReady = $derived(savings.connected && energyTotalKwh > 0.05);
  const solarSharePct = $derived(flowsReady ? (solarSelfKwh / energyTotalKwh) * 100 : 0);
  const gridSharePct = $derived(flowsReady ? (gridImportKwh / energyTotalKwh) * 100 : 0);
  // Couleurs vives locales (les tokens gris/vert seraient trop discrets sur de
  // petits segments). Ne touchent pas aux tokens globaux (Sankey).
  const EDF_BLUE = 'oklch(0.62 0.19 256)'; // réseau EDF (import)
  const SURPLUS_RED = 'oklch(0.62 0.21 27)'; // surplus renvoyé

  // Le cumul « depuis l'installation » (production totale, équivalent VE) a
  // déménagé dans le menu ☰ → « Bilan & installation » (/menu/bilan), qui porte
  // désormais le store productionLifetime.

  function fmtNumber(n: number, decimals = 0): string {
    return n.toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }
  function fmtW(w: number): string {
    return Math.round(Math.abs(w)).toLocaleString('fr-FR').replace(/\s/g, ' ');
  }
</script>

<div class="relative overflow-x-clip">
  <!-- gap/padding plus serrés sur mobile (condensation iPhone vertical) ; généreux dès sm.
       Dès l'iPad (`pad:`, les DEUX orientations) la pile devient une GRILLE 2 colonnes
       où chaque carte est placée explicitement — l'ordre du DOM (= l'ordre iPhone)
       reste donc intact, et l'accueil tient d'un seul écran au lieu de dérouler
       1 200 px. Cf. `@custom-variant pad` dans src/app.css. -->
  <div
    class="home-grid relative flex flex-col gap-3.5 pb-3 sm:gap-5 sm:pb-4"
    class:stagger-enter={staggerEnter}
    style="z-index: 1;"
  >
    <!-- ═══ En-tête : bannière aurore « dôme OVNI » ═══ -->
    <img
      src="/header-accueil.webp?v=4"
      alt=""
      aria-hidden="true"
      class="home-banner -mb-3.5 h-[52px] w-full rounded-[var(--radius-2xl)] object-cover object-bottom sm:-mb-5 sm:h-[84px]"
    />

    <!-- Carte Batterie (snippet : rendue UNE fois, la grille la place). -->
    {#snippet batteryCard()}
      <!-- ═══ Batterie — SOC parc + 3 barres par pack (SB3-1 / SB3-2 / Max AC) ═══ -->
      <div
        class="bat-card flex flex-col gap-3 rounded-[var(--radius-xl)] border px-4 py-3"
        class:is-charging={batteryOnline && batChargeA > 1}
        class:is-discharging={batteryOnline && batDischargeA > 1}
        class:is-offline={!batteryOnline}
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <!-- Résumé parc : SOC moyen + état + flux net + énergie stockée -->
        <div class="flex items-center justify-between gap-3">
          <!-- Gauche : SOC numérique + état -->
          <div class="flex shrink-0 flex-col">
            <div class="flex items-baseline gap-1">
              {#if batteryOnline}
                <span
                  class="bat-soc text-3xl leading-none font-bold tabular-nums"
                  style="color: var(--color-fg);"
                  >{Math.round(Math.max(0, Math.min(100, socA)))}</span
                >
                <span
                  class="text-base leading-none font-semibold"
                  style="color: var(--color-muted-fg);">%</span
                >
              {:else}
                <span
                  class="bat-soc text-3xl leading-none font-bold"
                  style="color: var(--color-muted-fg);">—</span
                >
              {/if}
            </div>
            <!-- Le MOT « Charge » / « Décharge » puis le POINT de couleur ont été
                 retirés (03/08/2026) : le flux signé à droite (+1 234 W / −1 234 W),
                 lui-même coloré, porte déjà le sens. Ne restent que les états que le
                 chiffre ne porte PAS : hors ligne (rien à mesurer) et repos (flux
                 nul, où « — » seul serait muet). L'état complet est repris en
                 aria-label du flux — il ne doit pas rester une pure couleur. -->
            {#if !batteryOnline || (batChargeA <= 1 && batDischargeA <= 1)}
              <span
                class="mt-1.5 text-[0.6875rem] leading-none font-semibold tracking-wide uppercase"
                style="color: var(--color-muted-fg);"
              >
                {batteryOnline ? 'Repos' : 'Hors ligne'}
              </span>
            {/if}
          </div>

          <!-- Droite : flux (W) + énergie stockée -->
          <div class="flex shrink-0 flex-col items-end">
            <span
              class="bat-flow text-sm leading-none font-semibold tabular-nums"
              aria-label={!batteryOnline
                ? 'Batteries hors ligne'
                : batChargeA > 1
                  ? `En charge, ${fmtW(batChargeA)} watts`
                  : batDischargeA > 1
                    ? `En décharge, ${fmtW(batDischargeA)} watts`
                    : 'Batteries au repos'}
            >
              {#if batteryOnline && batChargeA > 1}+{fmtW(batChargeA)} W{:else if batteryOnline && batDischargeA > 1}−{fmtW(
                  batDischargeA
                )} W{:else}—{/if}
            </span>
            {#if batteryOnline && usableKwh > 0}
              <!-- « utiles » : sans ce mot, l'écart avec le % affiché à gauche
                   (réserve déduite ici, pas là) passerait pour une incohérence. -->
              <span
                class="mt-1.5 text-[0.6875rem] leading-none font-medium tabular-nums"
                style="color: var(--color-muted-fg);">{usableKwh.toFixed(1)} kWh utiles</span
              >
            {/if}
          </div>
        </div>
        <!-- Les 3 batteries EN BARRES DE PROGRESSION : SB3-1 / SB3-2 / Max AC -->
        {#if batteryOnline && batteryDetail.length}
          <!-- Pas de filet de séparation : l'espacement suffit à détacher les barres
               du résumé, et un trait de plus dans une carte de verre l'alourdit. -->
          <div class="flex flex-col gap-2 pt-1">
            {#each batteryDetail as b (b.label)}
              {@const flow = b.chargeW - b.dischargeW}
              {@const soc = Math.max(0, Math.min(100, b.soc))}
              <div class="flex items-center gap-2.5">
                <span
                  class="w-16 shrink-0 text-[0.6875rem] font-semibold tracking-[0.03em] uppercase"
                  style="color: var(--color-muted-fg);">{b.label}</span
                >
                <div
                  class="relative h-3 min-w-0 flex-1 overflow-hidden rounded-full"
                  style="background: color-mix(in oklch, var(--color-muted-fg) 16%, transparent);"
                >
                  <div
                    class="h-full rounded-full transition-[width] duration-500"
                    style="width: {soc}%; background: {soc <= 20
                      ? 'var(--color-hp)'
                      : 'var(--color-battery)'};"
                  ></div>
                </div>
                <span class="w-9 shrink-0 text-right text-[0.8125rem] font-bold tabular-nums"
                  >{Math.round(b.soc)}<span
                    class="text-[0.625rem] font-semibold"
                    style="color: var(--color-muted-fg);">%</span
                  ></span
                >
                <span
                  class="w-[46px] shrink-0 text-right text-[0.625rem] font-medium tabular-nums"
                  style="color: {flow > 20
                    ? 'var(--color-battery)'
                    : flow < -20
                      ? 'var(--color-consumption)'
                      : 'var(--color-muted-fg)'};"
                  >{#if flow > 20}▲{fmtW(flow)}{:else if flow < -20}▼{fmtW(flow)}{:else}—{/if}</span
                >
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/snippet}

    <!-- ═══ Bilan du jour — couverture solaire (sous la batterie) ═══ -->
    <!-- Barre empilée Solaire | Réseau EDF (part de la conso d'origine solaire,
         recorder) + surplus renvoyé en plus petit (export Linky). -->
    {#snippet flowsCard()}
      <div
        class="flex flex-col gap-2.5 rounded-[var(--radius-xl)] border px-4 py-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span
            class="text-[0.625rem] font-semibold tracking-[0.08em] uppercase"
            style="color: var(--color-muted-fg);"
          >
            Consommation aujourd'hui
          </span>
          {#if flowsReady}
            <span
              class="text-[0.8125rem] font-semibold tabular-nums"
              style="color: var(--color-fg);">{fmtNumber(energyTotalKwh, 1)} kWh</span
            >
          {/if}
        </div>

        {#if flowsReady}
          <!-- Barre empilée : Solaire | Surplus | Réseau EDF (3 parts = 100 %) -->
          <div
            class="flex h-7 overflow-hidden rounded-md"
            style="box-shadow: inset 1px 1px 2px oklch(0.3 0.03 286 / 0.2), inset -1px -1px 1px oklch(0.99 0.01 149 / 0.1);"
          >
            <div
              class="h-full transition-[width] duration-700"
              style="width: {solarSharePct}%; background: var(--color-solar);"
            ></div>
            <div
              class="h-full transition-[width] duration-700"
              style="width: {gridSharePct}%; background: {EDF_BLUE};"
            ></div>
          </div>

          <!-- Légende : Solaire · Surplus (au milieu) · Réseau EDF -->
          <div
            class="flex items-center justify-between text-[0.6875rem] font-semibold"
            style="color: var(--color-fg);"
          >
            <span class="flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full" style="background: var(--color-solar);"></span>
              Solaire {fmtNumber(solarSharePct, 1)}%
            </span>
            <span class="flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full" style="background: {EDF_BLUE};"></span>
              Réseau EDF {fmtNumber(gridSharePct, 1)}%
            </span>
          </div>

          <!-- Surplus renvoyé à EDF : ce n'est PAS de la consommation, donc pas une
               part de la barre — mais c'est le chiffre qui compte pour la convention
               Enedis, donc il est écrit en clair. Non mesuré ⇒ on le dit. -->
          <div
            class="flex items-center justify-between border-t pt-2 text-[0.6875rem]"
            style="border-color: var(--color-border); color: var(--color-muted-fg);"
          >
            <span class="flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full" style="background: {SURPLUS_RED};"></span>
              Renvoyé à EDF
            </span>
            <span class="font-semibold tabular-nums" style="color: var(--color-fg);">
              {gridExportKwh === null ? 'non mesuré' : `${fmtNumber(gridExportKwh, 1)} kWh`}
            </span>
          </div>
        {:else}
          <p class="text-[13px]" style="color: var(--color-muted-fg);">
            <!-- `status === 'idle'` = pas encore interrogé (SSR, premier rendu) :
                 on ne crie pas la panne avant d'avoir seulement essayé. -->
            {savings.connected || savings.status === 'idle'
              ? 'Bilan du jour en cours de mesure…'
              : 'Chiffres du jour momentanément indisponibles.'}
          </p>
        {/if}
      </div>
    {/snippet}

    <!-- ═══ Économies solaires — carte héro, pleine largeur (les 4 médailles ont
         besoin de la largeur ; en demi-colonne elles deviennent illisibles) ═══ -->
    <div class="home-savings"><SavingsCard /></div>

    <!-- Batterie : 2ᵉ sur iPhone (au-dessus du Sankey) ; sur iPad, en HAUT de la
         colonne de droite — l'ordre du DOM ne bouge pas, seul le placement change. -->
    <div class="home-bat">{@render batteryCard()}</div>

    <!-- Sankey : colonne de gauche sur iPad, sur 2 rangées (il est carré, donc
         deux fois plus haut que la batterie et le bilan qui lui font face). -->
    <div class="home-sankey flex flex-col gap-3.5 sm:gap-4">
      <FlowDiagram
        pvSudW={pvSudA}
        pvOuestW={pvOuestA}
        homePowerW={homeA}
        batteryChargeW={batChargeA}
        batteryDischargeW={batDischargeA}
        batterySoc={socA}
        gridPowerW={gridA}
        {cumulusW}
        {homeConfidence}
        batteries={batteryOnline ? batteryDetail : []}
      />
      {#if sourcesMuettes.length}
        <!-- Un nœud absent du schéma ne veut rien dire tout seul : sans cette
               ligne, retirer les fausses valeurs remplacerait un mensonge par un
               silence. Phrase courte, en français, sans nom de matériel. -->
        <p
          class="px-1 text-[13px] leading-snug"
          style="color: var(--color-text-muted)"
          role="status"
        >
          {sourcesMuettes.join(' · ')} — le schéma n'affiche que ce qui est réellement mesuré.
        </p>
      {/if}
    </div>

    <!-- Énergie du jour : SOUS la carte apports/usages sur iPhone ; sur iPad elle
         passe sous la batterie, à droite du Sankey — c'est elle qui comblait le
         grand vide de la colonne de droite.
         (Les KPI « depuis l'installation » ont rejoint le menu ☰ → « Bilan &
         installation » : un cumul de plusieurs années n'a rien à faire sur
         l'écran qu'on ouvre dix fois par jour.) -->
    <div class="home-flows">{@render flowsCard()}</div>
  </div>
</div>

<style>
  /* ═══ Mise en page iPad ══════════════════════════════════════════════════
     iPhone : pile simple (le `flex flex-col` du markup). Dès l'iPad, la pile
     devient une grille et chaque carte est placée à la main — l'ordre du DOM
     reste donc celui de l'iPhone, seul le placement change.

     PORTRAIT (2 colonnes) : Économies en tête, puis le Sankey à gauche face à
     la batterie et au bilan du jour.

     PAYSAGE (3 colonnes) : le Sankey est CARRÉ — plus sa colonne est large,
     plus il est haut. En deux colonnes il imposait 520 px de hauteur à deux
     cartes qui en font 300 à elles deux : 220 px de vide. Il tient donc la
     colonne large, et les trois cartes de lecture se rangent à sa droite sur
     deux rangées, ce qui ramène l'écart sous 30 px. */
  @media (min-width: 768px) and (min-height: 600px) {
    .home-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: auto auto min-content 1fr;
      align-items: start;
    }
    .home-banner,
    .home-savings {
      grid-column: 1 / -1;
    }
    .home-sankey {
      grid-column: 1;
      grid-row: 3 / span 2;
    }
    .home-bat {
      grid-column: 2;
      grid-row: 3;
    }
    .home-flows {
      grid-column: 2;
      grid-row: 4;
    }
  }
  /* Seuil à 1120 px et non 1024 : sur un iPad 9 en paysage (1024), trois
     colonnes réduiraient les barres de SoC à 40 px. */
  @media (min-width: 1120px) and (min-height: 600px) {
    .home-grid {
      grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr) minmax(0, 1fr);
      grid-template-rows: auto auto auto;
    }
    .home-savings {
      grid-column: 2 / -1;
      grid-row: 2;
    }
    .home-sankey {
      grid-column: 1;
      grid-row: 2 / span 2;
    }
    .home-bat {
      grid-column: 2;
      grid-row: 3;
    }
    .home-flows {
      grid-column: 3;
      grid-row: 3;
    }
  }

  /* ═══ Carte Batterie : le flux porte l'état (le NIVEAU est dans les 3 barres) ═══ */
  .bat-flow {
    color: var(--color-muted-fg);
  }
  /* ── CHARGE : flux vert ── */
  .bat-card.is-charging .bat-flow {
    color: var(--color-battery);
  }
  /* ── DÉCHARGE : flux orange ── */
  .bat-card.is-discharging .bat-flow {
    color: var(--color-solar);
  }
  /* (La classe `is-low` a disparu avec le point : elle ne pilotait que sa couleur.
     Le niveau bas reste signalé — chaque barre passe au corail sous 20 %.) */
  /* ── HORS LIGNE : désature le SOC ── */
  .bat-card.is-offline .bat-soc {
    opacity: 0.6;
  }
  /* iPhone compact. */
  @media (max-width: 380px) {
    .bat-soc {
      font-size: 1.625rem;
    }
  }
</style>
