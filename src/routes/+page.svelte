<script lang="ts">
  import FlowDiagram from '$components/charts/FlowDiagram.svelte';
  import KpiCard from '$components/cards/KpiCard.svelte';
  import SavingsCard from '$components/cards/SavingsCard.svelte';
  import { anker } from '$stores/anker.svelte';
  import { ankerLocal } from '$stores/ankerLocal.svelte';
  import { production } from '$stores/production.svelte';
  import { savings } from '$stores/savings.svelte';
  import { dashboard } from '$stores/dashboard.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { apsystems } from '$stores/apsystems.svelte';
  import { shelly } from '$stores/shelly.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { pagerNav } from '$lib/pager/pager-nav.svelte';
  import { productionLifetime } from '$stores/productionLifetime.svelte';
  import { Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { onMount, onDestroy } from 'svelte';

  // ─── Source canonique : Anker quand connecté, mock sinon ─────────────
  // Tout en watts, signed (+ import / − export).
  // Solaire séparé par pan (installation Sanguinet) :
  //   • Sud   = onduleur APS (EZ1) + SolarBank 1 (alias *-1)
  //   • Ouest = SolarBank 2 (alias *-2)
  // Répartition agrégée robuste : anker.sb1SolarW/sb2SolarW = solar_power_w (agrégat
  // FIABLE) ventilé par le dernier ratio par-unité connu (les champs par-unité sont
  // intermittents). Purement AFFICHAGE : n'entre JAMAIS dans le calcul d'économies
  // (recorder serveur, 100 % AC).
  const pvSudW = $derived(
    anker.connected
      ? production.apsW + anker.sb1SolarW
      : Math.round(dashboard.solarPower * 1000 * 0.6)
  );
  const pvOuestW = $derived(
    anker.connected ? anker.sb2SolarW : Math.round(dashboard.solarPower * 1000 * 0.4)
  );
  // Réseau FIABLE — PRIORITÉ à l'EM-50 (compteur local Shelly : mesure instantanée
  // signée, recoupée Anker à ±10 W — la raison d'être de son intégration). 1er repli :
  // le Smart Meter Gen 2 lu en Modbus LOCAL (même convention de signe, vérifiée ;
  // instantané, sans cloud). 2e repli : le dérivé Linky d'Anker (fiable mais lent,
  // ~5 min) ; le grid_power_w INSTANTANÉ du cloud Solix, lui, reste inexploitable
  // (paliers figés, signe instable, fantômes). Mock Shelly en dernier recours.
  const gridPowerW = $derived(
    em50.available
      ? em50.gridPowerW
      : ankerLocal.meterAvailable
        ? ankerLocal.meterGridPowerW
        : anker.connected
          ? anker.gridReliableW
          : shelly.gridPowerW
  );
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
    return anker.connected ? (anker.averageSoc ?? 0) : dashboard.batteryLevel;
  });
  // Charge (→ usage) et décharge (→ apport) SÉPARÉES. Le Sankey peut ainsi
  // montrer la batterie du bon côté (voire les deux).
  const batteryChargeW = $derived.by(() => {
    if (localBatteryUp) {
      const sb3W = cloudSb3.reduce((s, b) => s + b.chargingPowerW, 0);
      return sb3W + Math.max(0, -ankerLocal.batteryPowerW);
    }
    return anker.connected ? anker.batteryChargeW : dashboard.batteryStatus === 'charge' ? 400 : 0;
  });
  const batteryDischargeW = $derived.by(() => {
    if (localBatteryUp) {
      const sb3W = cloudSb3.reduce((s, b) => s + b.dischargingPowerW, 0);
      return sb3W + Math.max(0, ankerLocal.batteryPowerW);
    }
    return anker.connected
      ? anker.batteryDischargeW
      : dashboard.batteryStatus === 'charge'
        ? 0
        : 600;
  });

  // Détail PAR PACK : les 2 Solarbank 3 (cloud, hors A17E2) + la Max AC (Modbus local
  // prioritaire, sinon repli cloud). Sert à ÉCLATER le nœud Batterie du Sankey ET à la
  // carte Charge. SoC = donnée fiable ; charge/décharge = best-effort (indicateur).
  interface BatteryDetail {
    label: string;
    soc: number;
    chargeW: number;
    dischargeW: number;
  }
  const batteryDetail = $derived.by((): BatteryDetail[] => {
    const out: BatteryDetail[] = [];
    cloudSb3.forEach((b, i) =>
      out.push({
        label: `SB3-${i + 1}`,
        soc: b.soc,
        chargeW: Math.max(0, b.chargingPowerW),
        dischargeW: Math.max(0, b.dischargingPowerW)
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
  onMount(() => productionLifetime.connect());
  onDestroy(() => {
    em50.clearBoost();
    apsystems.clearBoost();
    ankerLocal.clearBoost();
    productionLifetime.disconnect();
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

  // ─── Énergie stockée en batterie (kWh) — pour la carte Batterie ───────
  // Local up : SB3 cloud (sans l'entrée Max AC, dédupliquée) + Max AC locale.
  // Local down : total cloud tel quel (il inclut désormais la Max AC).
  const storedKwh = $derived.by(() => {
    if (localBatteryUp) {
      return (cloudSb3.reduce((s, b) => s + b.energyWh, 0) + ankerLocal.energyWh) / 1000;
    }
    return anker.totalBatteryEnergyWh / 1000;
  });

  // ─── Bilan énergie du JOUR — répartition de toute l'énergie brassée ──────
  // 3 parts d'un même total (= 100 %) : solaire autoconsommé + surplus renvoyé
  // à EDF (production) + soutirage réseau (import). Le surplus EST de l'énergie
  // produite → il compte dans le pourcentage.
  // Sources : auto & import = recorder (savings) ; surplus = cumul Linky du
  // bridge Anker (le recorder sous-estime le surplus faible).
  const solarSelfKwh = $derived(savings.today.kwh); // solaire consommé sur place
  const gridImportKwh = $derived(savings.today.import_kwh); // soutiré à EDF (recorder)
  const gridExportKwh = $derived(anker.gridExportTodayKwh); // surplus injecté (Linky)
  const energyTotalKwh = $derived(solarSelfKwh + gridImportKwh + gridExportKwh);
  const flowsReady = $derived(energyTotalKwh > 0.05);
  const solarSharePct = $derived(flowsReady ? (solarSelfKwh / energyTotalKwh) * 100 : 0);
  const surplusSharePct = $derived(flowsReady ? (gridExportKwh / energyTotalKwh) * 100 : 0);
  const gridSharePct = $derived(flowsReady ? (gridImportKwh / energyTotalKwh) * 100 : 0);
  // Couleurs vives locales (les tokens gris/vert seraient trop discrets sur de
  // petits segments). Ne touchent pas aux tokens globaux (Sankey).
  const EDF_BLUE = 'oklch(0.62 0.19 256)'; // réseau EDF (import)
  const SURPLUS_RED = 'oklch(0.62 0.21 27)'; // surplus renvoyé

  // ─── Cards lifetime — production cumulée de TOUTE l'installation ──────
  // Source FIABLE : /api/production/lifetime = MAX des compteurs MATÉRIELS historisés
  // par le recorder (APS EZ1 ~1276 kWh + SolarBank ~2042 kWh). Robuste au bug cloud
  // « daily-as-lifetime » : depuis la reconfiguration des systèmes Anker (22/07), le
  // cloud SolarBank renvoie la production du JOUR (~25 kWh) à la place du cumul — d'où
  // le total et l'équivalent VE jadis FAUX. Le max recorder ne redescend jamais.
  const hasLifetime = $derived(productionLifetime.available && productionLifetime.totalKwh > 0);
  // Équivalent VE : l'énergie produite depuis l'installation, convertie en km
  // qu'une voiture électrique parcourrait (conso ~16,7 kWh/100 km → 6 km/kWh).
  const EV_KM_PER_KWH = 6;
  const evKm = $derived(productionLifetime.totalKwh * EV_KM_PER_KWH);

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
  <!-- gap/padding plus serrés sur mobile (condensation iPhone vertical) ; généreux dès sm. -->
  <div
    class="stagger-enter relative flex flex-col gap-3.5 pb-3 sm:gap-5 sm:pb-4"
    style="z-index: 1;"
  >
    <!-- ═══ En-tête : bannière aurore « dôme OVNI » ═══ -->
    <img
      src="/header-accueil.webp?v=4"
      alt=""
      aria-hidden="true"
      class="-mb-3.5 h-[52px] w-full rounded-[var(--radius-2xl)] object-cover object-bottom sm:-mb-5 sm:h-[84px]"
    />

    <!-- Carte Batterie définie en snippet → rendue à 2 endroits : au-dessus du
         Sankey sur mobile, dans la colonne stats droite dès lg. -->
    {#snippet batteryCard()}
      <!-- ═══ Batterie — SOC parc + 3 barres par pack (SB3-1 / SB3-2 / Max AC) ═══ -->
      <div
        class="bat-card flex flex-col gap-3 rounded-[var(--radius-xl)] border px-4 py-3"
        class:is-charging={batteryOnline && batChargeA > 1}
        class:is-discharging={batteryOnline && batDischargeA > 1}
        class:is-low={batteryOnline && socA <= 20}
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
            <div class="mt-1.5 flex items-center gap-1.5">
              <span class="bat-dot h-1.5 w-1.5 shrink-0 rounded-full"></span>
              <span
                class="text-[0.6875rem] leading-none font-semibold tracking-wide uppercase"
                style="color: var(--color-muted-fg);"
              >
                {#if !batteryOnline}Hors ligne{:else if batChargeA > 1}Charge{:else if batDischargeA > 1}Décharge{:else}Repos{/if}
              </span>
            </div>
          </div>

          <!-- Droite : flux (W) + énergie stockée -->
          <div class="flex shrink-0 flex-col items-end">
            <span class="bat-flow text-sm leading-none font-semibold tabular-nums">
              {#if batteryOnline && batChargeA > 1}+{fmtW(batChargeA)} W{:else if batteryOnline && batDischargeA > 1}−{fmtW(
                  batDischargeA
                )} W{:else}—{/if}
            </span>
            {#if batteryOnline && storedKwh > 0}
              <span
                class="mt-1.5 text-[0.6875rem] leading-none font-medium tabular-nums"
                style="color: var(--color-muted-fg);">{storedKwh.toFixed(1)} kWh</span
              >
            {/if}
          </div>
        </div>
        <!-- Les 3 batteries EN BARRES DE PROGRESSION : SB3-1 / SB3-2 / Max AC -->
        {#if batteryOnline && batteryDetail.length}
          <div
            class="flex flex-col gap-2 border-t pt-2.5"
            style="border-color: var(--color-border);"
          >
            {#each batteryDetail as b (b.label)}
              {@const flow = b.chargeW - b.dischargeW}
              {@const soc = Math.max(0, Math.min(100, b.soc))}
              <div class="flex items-center gap-2.5">
                <span
                  class="w-12 shrink-0 text-[0.6875rem] font-semibold tracking-[0.03em] uppercase"
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
            Énergie du jour
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
              style="width: {surplusSharePct}%; background: {SURPLUS_RED};"
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
              <span class="h-2 w-2 rounded-full" style="background: {SURPLUS_RED};"></span>
              Surplus {fmtNumber(surplusSharePct, 1)}%
            </span>
            <span class="flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full" style="background: {EDF_BLUE};"></span>
              Réseau EDF {fmtNumber(gridSharePct, 1)}%
            </span>
          </div>
        {:else}
          <p class="text-[13px]" style="color: var(--color-muted-fg);">
            Bilan du jour en cours de mesure…
          </p>
        {/if}
      </div>
    {/snippet}

    <!-- ═══ Économies solaires — carte héro en première position ═══ -->
    <SavingsCard />

    <!-- Batterie EN PREMIER sur mobile (au-dessus du Sankey) ; masquée dès lg. -->
    <div class="lg:hidden">{@render batteryCard()}</div>

    <!-- ═══ Paysage (iPad/desktop) : Sankey | stats côte à côte ; mobile : empilé ═══ -->
    <!-- items-stretch : la colonne stats remplit la hauteur du Sankey carré (sinon
         un grand vide à droite sur desktop). -->
    <div class="grid gap-3.5 sm:gap-5 lg:grid-cols-2 lg:items-stretch">
      <!-- Colonne gauche : bilan apports / usages (Sankey) + détail par batterie -->
      <div class="flex flex-col gap-3.5 sm:gap-4">
        <FlowDiagram
          pvSudW={pvSudA}
          pvOuestW={pvOuestA}
          homePowerW={homeA}
          batteryChargeW={batChargeA}
          batteryDischargeW={batDischargeA}
          batterySoc={socA}
          gridPowerW={gridA}
          cumulusW={em50.cumulusPowerW}
          {homeConfidence}
          batteries={batteryOnline ? batteryDetail : []}
        />
        <!-- Énergie du jour : SOUS la carte apports/usages (mobile ET desktop). -->
        {@render flowsCard()}
      </div>

      <!-- Colonne stats : remplit la hauteur du Sankey (justify-between) ─────── -->
      <div class="flex flex-col gap-4 lg:justify-between">
        <!-- Batterie : colonne droite dès lg (sur mobile elle passe au-dessus du
             Sankey, cf. snippet batteryCard rendu plus haut). -->
        <div class="hidden lg:block">{@render batteryCard()}</div>

        <!-- ═══ KPI lifetime (SolarBank + APsystems, vraies données) ═══ -->
        {#if hasLifetime}
          <div class="grid grid-cols-2 gap-3">
            <KpiCard
              label="Production totale"
              value={fmtNumber(productionLifetime.totalKwh, 0)}
              unit="kWh"
              trend="depuis l'installation"
              domain="solar"
            />
            <KpiCard
              label="Équivalent VE"
              value={fmtNumber(evKm, 0)}
              unit="km"
              trend="en voiture électrique"
              domain="battery"
            />
          </div>
        {:else}
          <!-- Anker pas connecté : carte unique d'état -->
          <div
            class="rounded-[var(--radius-xl)] border p-4"
            style="background: var(--color-card); border-color: var(--color-border);"
          >
            <span
              class="text-[11px] font-semibold tracking-[0.08em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Statistiques
            </span>
            <p class="mt-1 text-[13px]" style="color: var(--color-muted-fg);">
              En attente du bridge Anker pour les compteurs historiques.
            </p>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  /* ═══ Carte Batterie : point d'état + flux (le NIVEAU est dans les 3 barres) ═══ */
  .bat-dot {
    background: var(--color-muted-fg);
    transition: background-color 300ms ease;
  }
  .bat-flow {
    color: var(--color-muted-fg);
  }
  /* ── CHARGE : point + flux verts ── */
  .bat-card.is-charging .bat-dot {
    background: var(--color-battery);
    box-shadow: 0 0 6px var(--color-battery);
  }
  .bat-card.is-charging .bat-flow {
    color: var(--color-battery);
  }
  /* ── DÉCHARGE : point + flux orange ── */
  .bat-card.is-discharging .bat-dot {
    background: var(--color-solar);
    box-shadow: 0 0 6px var(--color-solar);
  }
  .bat-card.is-discharging .bat-flow {
    color: var(--color-solar);
  }
  /* ── NIVEAU BAS parc (≤ 20 %) : point orange (les barres passent au corail) ── */
  .bat-card.is-low .bat-dot {
    background: var(--color-solar);
  }
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
