<script lang="ts">
  import FlowDiagram from '$components/charts/FlowDiagram.svelte';
  import KpiCard from '$components/cards/KpiCard.svelte';
  import SavingsCard from '$components/cards/SavingsCard.svelte';
  import { anker } from '$stores/anker.svelte';
  import { production } from '$stores/production.svelte';
  import { savings } from '$stores/savings.svelte';
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
  // Réseau FIABLE — dérivé du compteur Linky (anker.gridReliableW). Le grid_power_w
  // instantané du cloud est inexploitable (paliers figés, signe instable, aveugle à
  // l'APS → imports/exports fantômes de plusieurs centaines de W). Mock Shelly hors Anker.
  const gridPowerW = $derived(anker.connected ? anker.gridReliableW : shelly.gridPowerW);
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
  // Maison = PV + réseau net − batterie nette. Le réseau (gridA) est désormais la
  // mesure Linky FIABLE, donc le bilan se referme correctement sans terme correctif.
  // Équilibre instantané ; pertes de conversion < 5 % ignorées.
  const homeA = $derived(Math.max(0, Math.round(pvA + gridA - batA)));

  // ─── Énergie stockée en batterie (kWh) — pour la carte Batterie ───────
  const storedKwh = $derived(anker.totalBatteryEnergyWh / 1000);

  // ─── Bilan énergie du JOUR — couverture solaire (carte sous la batterie) ──
  // Couverture = part de la conso maison d'origine solaire vs réseau EDF
  // (recorder/savings, cohérent entre eux). Surplus = part de la prod renvoyée
  // à EDF (export Linky du bridge Anker ; le recorder sous-estime le surplus).
  const solarSelfKwh = $derived(savings.today.kwh); // solaire consommé sur place
  const gridImportKwh = $derived(savings.today.import_kwh); // soutiré à EDF (recorder)
  const homeConsoKwh = $derived(solarSelfKwh + gridImportKwh); // conso maison du jour
  const gridExportKwh = $derived(anker.gridExportTodayKwh); // surplus injecté (Linky)
  const flowsReady = $derived(homeConsoKwh > 0.05); // au moins un peu de conso mesurée
  const solarCoverage = $derived(
    flowsReady ? Math.max(0, Math.min(100, savings.today.coverage_pct)) : 0
  );
  const solarPct = $derived(Math.round(solarCoverage)); // % solaire (libellé)
  const gridPct = $derived(100 - solarPct); // % réseau (somme = 100)
  const surplusPct = $derived(
    gridExportKwh > 0 ? (gridExportKwh / (solarSelfKwh + gridExportKwh)) * 100 : 0
  ); // part de la production solaire renvoyée à EDF
  // Part EDF de la barre de couverture : bleu vif (le gris « réseau » du Sankey
  // est trop discret sur un petit segment). Local à cette carte — ne touche pas
  // au token --color-grid-energy (gris voulu ailleurs).
  const EDF_BLUE = 'oklch(0.62 0.19 256)';

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
</script>

<svelte:head>
  <title>Domo</title>
</svelte:head>

<div class="relative overflow-x-clip">
  <!-- gap/padding plus serrés sur mobile (condensation iPhone vertical) ; généreux dès sm. -->
  <div
    class="stagger-enter relative flex flex-col gap-3.5 py-3 sm:gap-5 sm:py-4"
    style="z-index: 1;"
  >
    <!-- ═══ En-tête : bannière aurore « dôme OVNI » ═══ -->
    <img
      src="/header-accueil.webp?v=4"
      alt=""
      aria-hidden="true"
      class="-mb-3.5 w-full rounded-[var(--radius-2xl)] sm:-mb-5"
    />

    <!-- Carte Batterie définie en snippet → rendue à 2 endroits : au-dessus du
         Sankey sur mobile, dans la colonne stats droite dès lg. -->
    {#snippet batteryCard()}
      <!-- ═══ Batterie — charge (SOC) + jauge segmentée OVNI (workflow + juge) ═══ -->
      <div
        class="bat-card flex items-center gap-3 rounded-[var(--radius-xl)] border px-4 py-3"
        class:is-charging={anker.connected && batChargeA > 1}
        class:is-discharging={anker.connected && batDischargeA > 1}
        class:is-low={anker.connected && socA <= 20}
        class:is-offline={!anker.connected}
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <!-- Gauche : SOC numérique + état -->
        <div class="flex shrink-0 flex-col">
          <div class="flex items-baseline gap-1">
            {#if anker.connected}
              <span
                class="bat-soc text-3xl leading-none font-bold tabular-nums"
                style="color: var(--color-fg);">{Math.round(Math.max(0, Math.min(100, socA)))}</span
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
              {#if !anker.connected}Hors ligne{:else if batChargeA > 1}Charge{:else if batDischargeA > 1}Décharge{:else}Repos{/if}
            </span>
          </div>
        </div>

        <!-- Centre : jauge segmentée + borne -->
        <div class="flex min-w-0 flex-1 items-center gap-1.5">
          <div class="bat-cells flex h-9 min-w-0 flex-1 items-stretch gap-[3px] rounded-md p-[3px]">
            {#each Array.from({ length: 10 }) as _, i}
              {@const lo = i * 10}
              {@const lvl = anker.connected ? Math.max(0, Math.min(100, socA)) : 0}
              {@const fill = Math.max(0, Math.min(1, (lvl - lo) / 10))}
              {@const active = lvl > lo + 0.5}
              {@const isEdge = active && lvl <= lo + 10.5}
              <div class="bat-cell" class:is-active={active} class:is-edge={isEdge}>
                <div class="bat-cell-fill" style="transform: scaleX({fill});"></div>
              </div>
            {/each}
          </div>
          <span class="bat-nub h-3.5 w-[3px] shrink-0 rounded-r-sm"></span>
        </div>

        <!-- Droite : flux (W) + énergie stockée -->
        <div class="flex shrink-0 flex-col items-end">
          <span class="bat-flow text-sm leading-none font-semibold tabular-nums">
            {#if anker.connected && batChargeA > 1}+{fmtW(batChargeA)} W{:else if anker.connected && batDischargeA > 1}−{fmtW(
                batDischargeA
              )} W{:else}—{/if}
          </span>
          {#if anker.connected && storedKwh > 0}
            <span
              class="mt-1.5 text-[0.6875rem] leading-none font-medium tabular-nums"
              style="color: var(--color-muted-fg);">{storedKwh.toFixed(1)} kWh</span
            >
          {/if}
        </div>
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
        <div
          class="text-[0.625rem] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Conso du jour
        </div>

        {#if flowsReady}
          <!-- Gros % de couverture + échelle de conso -->
          <div class="flex items-end justify-between gap-2">
            <span class="flex items-center gap-2">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-solar)"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="4" />
                <path
                  d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
                />
              </svg>
              <span
                class="text-[2rem] leading-none font-bold tabular-nums"
                style="color: var(--color-fg);"
                >{solarPct}<span class="text-lg font-semibold" style="color: var(--color-muted-fg);"
                  >%</span
                ></span
              >
            </span>
            <span
              class="text-right text-[0.6875rem] leading-tight font-medium"
              style="color: var(--color-muted-fg);"
              >sur {fmtNumber(homeConsoKwh, 1)} kWh<br />consommés</span
            >
          </div>

          <!-- Barre empilée solaire | réseau EDF (recessed glass) -->
          <div
            class="relative h-7 overflow-hidden rounded-md"
            style="background: {EDF_BLUE}; box-shadow: inset 1px 1px 2px oklch(0.3 0.03 286 / 0.2), inset -1px -1px 1px oklch(0.99 0.01 149 / 0.1);"
          >
            <div
              class="absolute inset-y-0 left-0 transition-[width] duration-700"
              style="width: {solarCoverage}%; background: var(--color-solar);"
            ></div>
          </div>

          <!-- Légende -->
          <div
            class="flex items-center justify-between text-[0.6875rem] font-semibold"
            style="color: var(--color-fg);"
          >
            <span class="flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full" style="background: var(--color-solar);"></span>
              Solaire {solarPct}%
            </span>
            <span class="flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full" style="background: {EDF_BLUE};"></span>
              Réseau EDF {gridPct}%
            </span>
          </div>

          <!-- Surplus renvoyé à EDF (part de la production) -->
          {#if anker.connected && gridExportKwh > 0}
            <div
              class="flex items-center gap-1.5 text-[0.6875rem] font-medium"
              style="color: var(--color-muted-fg);"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-battery)"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M12 21V9M7 14l5-5 5 5M5 3h14" />
              </svg>
              Surplus renvoyé à EDF ·
              <span class="font-semibold tabular-nums" style="color: var(--color-battery);"
                >{fmtNumber(surplusPct, 1)} %</span
              >
            </div>
          {/if}
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
    <!-- Bilan du jour juste sous la batterie (mobile). -->
    <div class="lg:hidden">{@render flowsCard()}</div>

    <!-- ═══ Paysage (iPad/desktop) : Sankey | stats côte à côte ; mobile : empilé ═══ -->
    <!-- items-stretch : la colonne stats remplit la hauteur du Sankey carré (sinon
         un grand vide à droite sur desktop). -->
    <div class="grid gap-3.5 sm:gap-5 lg:grid-cols-2 lg:items-stretch">
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
        <!-- Batterie : colonne droite dès lg (sur mobile elle passe au-dessus du
             Sankey, cf. snippet batteryCard rendu plus haut). -->
        <div class="hidden lg:block">{@render batteryCard()}</div>
        <!-- Bilan du jour juste sous la batterie (colonne stats, dès lg). -->
        <div class="hidden lg:block">{@render flowsCard()}</div>

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
      </div>
    </div>
  </div>
</div>

<style>
  /* ═══ Carte Batterie : jauge segmentée OVNI (conçue via workflow + juge) ═══ */
  /* Rail des cellules : léger creux en verre (relief inversé, cohérent HG/BD). */
  .bat-cells {
    background: var(--color-battery-muted);
    box-shadow:
      inset 1px 1px 2px oklch(0.3 0.03 286 / 0.18),
      inset -1px -1px 1px oklch(0.985 0.01 149 / 0.12);
  }
  /* Une cellule = case vide en verre. */
  .bat-cell {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    border-radius: 3px;
    overflow: hidden;
    background: var(--color-bg);
    box-shadow: inset 0 0 0 1px var(--color-border);
  }
  /* Remplissage vert, transition douce, ancré à gauche. */
  .bat-cell-fill {
    position: absolute;
    inset: 0;
    transform-origin: left center;
    transform: scaleX(0);
    border-radius: 2px;
    background: linear-gradient(
      180deg,
      oklch(0.85 0.17 152) 0%,
      oklch(0.76 0.19 152) 55%,
      oklch(0.66 0.2 152) 100%
    );
    transition:
      transform 700ms cubic-bezier(0.22, 1, 0.36, 1),
      background 300ms ease;
  }
  .bat-cell.is-active .bat-cell-fill {
    box-shadow: inset 0 1px 2px oklch(0.95 0.08 149 / 0.45);
  }
  /* Borne (+) en bout de batterie. */
  .bat-nub {
    background: var(--color-border-strong);
  }
  .bat-dot {
    background: var(--color-muted-fg);
    transition: background-color 300ms ease;
  }
  .bat-flow {
    color: var(--color-muted-fg);
  }
  /* ── CHARGE : vert, la cellule de front pulse ── */
  .bat-card.is-charging .bat-dot {
    background: var(--color-battery);
    box-shadow: 0 0 6px var(--color-battery);
  }
  .bat-card.is-charging .bat-flow {
    color: var(--color-battery);
  }
  .bat-card.is-charging .bat-cell.is-edge .bat-cell-fill {
    animation: batPulse 1.6s ease-in-out infinite;
  }
  @keyframes batPulse {
    0%,
    100% {
      box-shadow: inset 0 0 4px oklch(0.95 0.1 149 / 0.4);
      filter: brightness(1);
    }
    50% {
      box-shadow: inset 0 0 9px oklch(0.97 0.12 149 / 0.85);
      filter: brightness(1.18);
    }
  }
  /* ── DÉCHARGE : seuls le point + le flux passent orange. La JAUGE reste
     verte = elle indique le NIVEAU de charge, pas le sens du flux (sinon une
     batterie à 95 % en micro-décharge paraîtrait « faible »). ── */
  .bat-card.is-discharging .bat-dot {
    background: var(--color-solar);
    box-shadow: 0 0 6px var(--color-solar);
  }
  .bat-card.is-discharging .bat-flow {
    color: var(--color-solar);
  }
  /* ── NIVEAU BAS (≤ 20 %) : la jauge vire ambre = vrai avertissement ── */
  .bat-card.is-low .bat-cell-fill {
    background: linear-gradient(
      180deg,
      oklch(0.82 0.16 70) 0%,
      var(--color-solar) 55%,
      oklch(0.62 0.17 55) 100%
    );
  }
  .bat-card.is-low .bat-dot {
    background: var(--color-solar);
  }
  /* ── HORS LIGNE : neutralise et désature ── */
  .bat-card.is-offline .bat-cells {
    opacity: 0.45;
    filter: grayscale(0.6);
  }
  .bat-card.is-offline .bat-soc {
    opacity: 0.6;
  }
  /* iPhone compact. */
  @media (max-width: 380px) {
    .bat-soc {
      font-size: 1.625rem;
    }
    .bat-cells {
      height: 2rem;
      gap: 2px;
    }
  }
  /* Accessibilité : pas d'animation si refusée. */
  @media (prefers-reduced-motion: reduce) {
    .bat-card.is-charging .bat-cell.is-edge .bat-cell-fill {
      animation: none;
    }
    .bat-cell-fill {
      transition: none;
    }
  }
  /* Repli sans transparence (réglage iOS global). */
  @media (prefers-reduced-transparency: reduce) {
    .bat-cells {
      background: var(--color-battery-muted);
    }
    .bat-cell {
      background: var(--color-muted);
    }
  }
</style>
