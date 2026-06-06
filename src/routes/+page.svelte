<script lang="ts">
  import FlowDiagram from '$components/charts/FlowDiagram.svelte';
  import KpiCard from '$components/cards/KpiCard.svelte';
  import SavingsCard from '$components/cards/SavingsCard.svelte';
  import ConcentricRings from '$components/effects/ConcentricRings.svelte';
  import { anker } from '$stores/anker.svelte';
  import { production } from '$stores/production.svelte';
  import { savings } from '$stores/savings.svelte';
  import { tariff } from '$stores/tariff.svelte';
  import { settings } from '$stores/settings.svelte';
  import { dashboard } from '$stores/dashboard.svelte';
  import { cumulus } from '$stores/cumulus.svelte';
  import { shelly } from '$stores/shelly.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';

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
  // Réseau FILTRÉ (anti-transitoire cache cloud ~60 s) : plus de soutirage/injection
  // « fantôme » figé. Cf. anker.gridFilteredW.
  const gridPowerW = $derived(anker.connected ? anker.gridFilteredW : shelly.gridPowerW);
  const batterySoc = $derived(anker.connected ? (anker.averageSoc ?? 0) : dashboard.batteryLevel);
  // Charge (→ usage) et décharge (→ apport) SÉPARÉES, depuis l'agrégat fiable du
  // bridge. Le Sankey peut ainsi montrer la batterie du bon côté (voire les deux).
  const batteryChargeW = $derived(
    anker.connected ? anker.batteryChargeW : dashboard.batteryStatus === 'charge' ? 400 : 0
  );
  const batteryDischargeW = $derived(
    anker.connected ? anker.batteryDischargeW : dashboard.batteryStatus === 'charge' ? 0 : 600
  );

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
  // Maison = PV + import réseau − charge batterie (équilibre instantané ; pertes
  // de conversion < 5 % ignorées).
  const homeA = $derived(Math.max(0, Math.round(pvA + gridA - batA)));

  // ─── Hero : auto-conso + flux net ─────────────────────────────────────
  const autoConso = $derived(
    anker.connected ? Math.round(anker.selfConsumptionRate ?? 0) : dashboard.solarSelfConsumption
  );
  const autoTw = new Tween(0, { easing: cubicOut });
  $effect(() => void autoTw.set(autoConso, { duration: animMs, easing: cubicOut }));
  const autoA = $derived(Math.round(autoTw.current));

  // Direction du flux : seuils sur la valeur BRUTE (évite le clignotement des
  // libellés pendant l'interpolation) ; magnitude affichée = valeur animée.
  const isExporting = $derived(gridPowerW < -5);
  const isImporting = $derived(gridPowerW > 5);

  // ─── 3 cards lifetime (depuis Anker, vraies données) ─────────────────
  const hasLifetime = $derived(anker.connected && anker.lifetimeProductionKwh > 0);
  // CO2 évité = production totale × facteur réseau FRANCE (réglage, défaut ADEME
  // 0,052 kgCO2e/kWh). Remplace le compteur Anker (~0,5/kWh, mix générique européen)
  // largement surestimé pour le mix français bas carbone.
  const co2SavedKg = $derived(anker.lifetimeProductionKwh * settings.co2FactorKgKwh);

  function fmtNumber(n: number, decimals = 0): string {
    return n.toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }
  function fmtW(w: number): string {
    return Math.round(Math.abs(w)).toLocaleString('fr-FR').replace(/\s/g, ' ');
  }

  // ─── Footer : tarif RÉEL (store tariff, vraie fenêtre HC 00:06–08:06) ──
  const tariffReady = $derived(tariff.status === 'live'); // évite le flash 0,00 avant le 1er fetch
  const currentTariff = $derived(tariff.period);
  const currentPrice = $derived(tariff.priceEurKwh); // €/kWh
  const nextTariff = $derived(tariff.next.period);
  const nextSwitchAt = $derived(tariff.next.at); // 'HH:MM' local Paris
  const hoursUntilSwitch = $derived(tariff.nextInHours);
</script>

<svelte:head>
  <title>Domo</title>
</svelte:head>

<div class="relative overflow-x-clip">
  <!-- ═══ Décor de fond (vert OVNI) — anneaux orbitaux + particules ═══ -->
  <!-- Pausables, derrière le contenu ; ne s'affichent que si Animations activées. -->
  {#if preferences.animationsEnabled}
    <div
      class="pointer-events-none absolute inset-0 overflow-hidden"
      style="z-index: 0;"
      aria-hidden="true"
    >
      <!-- Anneaux concentriques centrés sur la zone hero/carte -->
      <div class="absolute inset-x-0 top-0" style="height: 660px;">
        <ConcentricRings />
      </div>
    </div>
  {/if}

  <div class="stagger-enter relative flex flex-col gap-5 py-4" style="z-index: 1;">
    <!-- ═══ Économies solaires — carte héro en première position ═══ -->
    <SavingsCard />

    <!-- ═══ Hero — Auto-consommation ═══ -->
    <header class="flex items-center justify-between gap-4">
      <div class="flex flex-col gap-1">
        <div class="flex items-baseline gap-2">
          <span
            class="text-[40px] leading-none font-bold tracking-tight sm:text-[48px]"
            style="color: var(--color-fg); letter-spacing: -0.02em;"
          >
            {autoA}<span class="text-[24px] font-semibold" style="color: var(--color-muted-fg);"
              >%</span
            >
          </span>
          <span
            class="text-[11px] font-semibold tracking-[0.08em] uppercase"
            style="color: var(--color-muted-fg);"
          >
            autoconso
          </span>
        </div>
        <span
          class="text-[13px] font-medium"
          style="color: {isExporting
            ? 'var(--color-solar)'
            : isImporting
              ? 'var(--color-grid-energy)'
              : 'var(--color-muted-fg)'};"
        >
          {#if isExporting}
            ↑ {fmtW(gridA)} W injectés sur le réseau
          {:else if isImporting}
            ↓ {fmtW(gridA)} W soutirés du réseau
          {:else}
            Réseau à l'équilibre
          {/if}
        </span>
      </div>

      <span
        class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] uppercase"
        style="background: {anker.connected
          ? 'var(--color-battery-muted)'
          : 'var(--color-warning) / 0.15'}; color: {anker.connected
          ? 'var(--color-battery)'
          : 'var(--color-warning)'};"
      >
        <span
          class="h-1.5 w-1.5 rounded-full"
          style="background: {anker.connected ? 'var(--color-battery)' : 'var(--color-warning)'};"
        ></span>
        {anker.connected ? 'Anker connecté' : 'Mode démo'}
      </span>
    </header>

    <!-- ═══ Paysage (iPad/desktop) : Sankey | stats côte à côte ; mobile : empilé ═══ -->
    <!-- items-stretch : la colonne stats remplit la hauteur du Sankey carré (sinon
         un grand vide à droite sur desktop). -->
    <div class="grid gap-5 lg:grid-cols-2 lg:items-stretch">
      <!-- Flow Diagram (carré centré, max 520px) -->
      <FlowDiagram
        pvSudW={pvSudA}
        pvOuestW={pvOuestA}
        homePowerW={homeA}
        batteryChargeW={batChargeA}
        batteryDischargeW={batDischargeA}
        batterySoc={socA}
        gridPowerW={gridA}
        cumulusTempC={cumulus.temperatureC}
        cumulusPowerW={shelly.cumulusPowerW}
        cumulusOn={shelly.cumulusRelayOn}
      />

      <!-- Colonne stats : remplit la hauteur du Sankey (justify-between) ─────── -->
      <div class="flex flex-col gap-4 lg:justify-between">
        <!-- ═══ KPI lifetime (vraies données Anker) ═══ -->
        {#if hasLifetime}
          <div class="grid grid-cols-2 gap-3">
            <KpiCard
              label="Production totale"
              value={fmtNumber(anker.lifetimeProductionKwh, 0)}
              unit="kWh"
              trend="depuis l'installation"
              domain="solar"
            />
            <KpiCard
              label="CO₂ évité"
              value={fmtNumber(co2SavedKg, 0)}
              unit="kg"
              trend={`≈ ${fmtNumber(co2SavedKg * 6, 0)} km en voiture`}
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

        <!-- ═══ Tarif & réseau réel — carte verticale (3 lignes) ═══ -->
        <!-- Réseau = import RÉEL du jour (recorder, pince SmartMeter, filtré
             transitoires) — fini le mock shelly. -->
        <div
          class="flex flex-col rounded-[var(--radius-xl)] border"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <div class="flex items-center justify-between gap-3 px-4 py-3">
            <span
              class="text-[10px] font-semibold tracking-[0.08em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Tarif en cours
            </span>
            <span
              class="text-[14px] font-semibold tabular-nums"
              style="color: {currentTariff === 'HC' ? 'var(--color-hc)' : 'var(--color-hp)'};"
            >
              {#if tariffReady}{currentTariff} · {(currentPrice * 100).toFixed(2)} cts/kWh{:else}—{/if}
            </span>
          </div>

          <div
            class="flex items-center justify-between gap-3 border-t px-4 py-3"
            style="border-color: var(--color-border);"
          >
            <span
              class="text-[10px] font-semibold tracking-[0.08em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Réseau soutiré aujourd'hui
            </span>
            <span
              class="text-[14px] font-semibold tabular-nums"
              style="color: var(--color-grid-energy);"
            >
              {#if savings.connected}↓ {savings.today.import_kwh.toFixed(2)} kWh{:else}—{/if}
            </span>
          </div>

          <div
            class="flex items-center justify-between gap-3 border-t px-4 py-3"
            style="border-color: var(--color-border);"
          >
            <span
              class="text-[10px] font-semibold tracking-[0.08em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Prochaine bascule
            </span>
            <span class="text-[14px] tabular-nums" style="color: var(--color-fg);">
              {#if tariffReady && nextSwitchAt}{nextTariff} à {nextSwitchAt} · dans {hoursUntilSwitch}
                h{:else}—{/if}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
