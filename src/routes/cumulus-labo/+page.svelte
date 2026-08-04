<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { cumulusShadow } from '$lib/stores/cumulusShadow.svelte';

  onMount(() => cumulusShadow.connect());
  onDestroy(() => cumulusShadow.disconnect());

  const cur = $derived(cumulusShadow.current);
  const samples = $derived(cumulusShadow.samples);
  const dOn = $derived(cumulusShadow.dOn);
  const dOff = $derived(cumulusShadow.dOff);

  const fmtTime = (ts: number | null): string =>
    ts
      ? new Date(ts).toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Paris'
        })
      : '—';

  // État « réel » du ballon, lisible.
  const reel = $derived(
    !cur ? '—' : cur.heatingNow ? 'chauffe' : cur.relayOn ? 'allumé' : 'éteint'
  );

  // Minutes estimées « aurait chauffé » sur la fenêtre (tick ~65 s).
  const wouldOnMin = $derived(Math.round((cumulusShadow.wouldOnCount * 65) / 60));

  // Les trois voies de surplus + les deux portails, pour les barres.
  const signaux = $derived(
    !cur
      ? []
      : [
          {
            key: 'curt',
            label: 'Écrêtage (batterie pleine + soleil)',
            v: cur.freeCurtail,
            color: 'var(--color-mandarine)'
          },
          {
            key: 'exp',
            label: 'Don franc au réseau',
            v: cur.freeExport,
            color: 'var(--color-cyan)'
          },
          {
            key: 'chg',
            label: 'Charge batterie > chauffe',
            v: cur.freeCharge,
            color: 'var(--color-success)'
          },
          {
            key: 'win',
            label: 'Fenêtre solaire (portail nuit)',
            v: cur.solarWindow,
            color: 'var(--color-ambre)'
          },
          {
            key: 'room',
            label: 'Place dans la cuve (portail plein)',
            v: cur.tankRoom,
            color: 'var(--color-consumption)'
          }
        ]
  );

  // ── Timeline SVG de D sur la fenêtre chargée ──
  const W = 320;
  const H = 96;
  const PAD = 4;
  const y = (d: number) => H - PAD - Math.max(0, Math.min(1, d)) * (H - 2 * PAD);
  const x = (i: number, n: number) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD));

  const dPath = $derived.by(() => {
    const n = samples.length;
    if (n === 0) return '';
    return samples
      .map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i, n).toFixed(1)},${y(s.d).toFixed(1)}`)
      .join(' ');
  });
  const dArea = $derived.by(() => {
    const n = samples.length;
    if (n === 0) return '';
    return (
      `M${x(0, n).toFixed(1)},${(H - PAD).toFixed(1)} ` +
      samples.map((s, i) => `L${x(i, n).toFixed(1)},${y(s.d).toFixed(1)}`).join(' ') +
      ` L${x(n - 1, n).toFixed(1)},${(H - PAD).toFixed(1)} Z`
    );
  });
  // Points où le modèle aurait chauffé (marqueurs corail).
  const onDots = $derived.by(() => {
    const n = samples.length;
    return samples.map((s, i) => ({ x: x(i, n), y: y(s.d), on: s.wouldOn })).filter((p) => p.on);
  });
  const firstTs = $derived(samples.length ? samples[0].ts : null);
  const lastTs = $derived(samples.length ? samples[samples.length - 1].ts : null);
</script>

<div class="flex flex-col gap-6 py-4">
  <header class="flex items-start justify-between gap-3">
    <div class="flex flex-col gap-1">
      <!-- Cette page n'est dans aucune barre de navigation : sans ce retour, on y
           serait en impasse (elle s'ouvre depuis le menu ☰ → Eau chaude). -->
      <a
        href="/menu/eau-chaude"
        class="text-[12px] font-medium"
        style="color: var(--color-primary);"
      >
        ← Eau chaude
      </a>
      <h1 class="text-2xl font-semibold tracking-tight">Labo cumulus — modèle shadow</h1>
      <span class="text-[12px]" style="color: var(--color-muted-fg);">
        Ce que le modèle mathématique <em>aurait</em> décidé, tick par tick.
      </span>
    </div>
    <span
      class="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-[0.06em] uppercase"
      style="background: color-mix(in oklch, var(--color-glow) 18%, transparent); color: var(--color-glow-bright); border: 1px solid color-mix(in oklch, var(--color-glow) 40%, transparent);"
    >
      Observation · ne pilote rien
    </span>
  </header>

  {#if cumulusShadow.status === 'error'}
    <div
      class="rounded-[var(--radius-2xl)] border p-4 text-[13px]"
      style="background: var(--color-card); border-color: var(--color-border); color: var(--color-muted-fg);"
    >
      Impossible de lire le shadow ({cumulusShadow.lastError}). Nouvelle tentative automatique.
    </div>
  {:else if !cur}
    <div
      class="rounded-[var(--radius-2xl)] border p-6 text-center text-[14px]"
      style="background: var(--color-card); border-color: var(--color-border); color: var(--color-muted-fg);"
    >
      En attente du premier tick du moteur… (un point toutes les ~65 s)
    </div>
  {:else}
    <div class="grid gap-6 lg:grid-cols-2 lg:items-start">
      <!-- ── Verdict courant ── -->
      <section
        class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-5"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="flex flex-col gap-0.5">
            <span
              class="text-[11px] tracking-[0.06em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Aurait chauffé ?
            </span>
            <span
              class="text-3xl font-bold tracking-tight"
              style="color: {cur.wouldOn ? 'var(--color-hp)' : 'var(--color-muted-fg)'};"
            >
              {cur.wouldOn ? 'OUI' : 'NON'}
            </span>
          </div>
          <div class="flex flex-col items-end gap-0.5">
            <span
              class="text-[11px] tracking-[0.06em] uppercase"
              style="color: var(--color-muted-fg);">Réel</span
            >
            <span
              class="text-[15px] font-semibold"
              style="color: {reel === 'chauffe'
                ? 'var(--color-hp)'
                : reel === 'allumé'
                  ? 'var(--color-success)'
                  : 'var(--color-muted-fg)'};"
            >
              {reel}
            </span>
          </div>
        </div>

        <!-- Jauge D avec seuils dOff / dOn -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <span
              class="text-[11px] tracking-[0.06em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Désirabilité D
            </span>
            <span class="text-[15px] font-bold tabular-nums">{cur.d.toFixed(2)}</span>
          </div>
          <div
            class="relative h-3 overflow-hidden rounded-full"
            style="background: color-mix(in oklch, var(--color-muted-fg) 18%, transparent);"
          >
            <div
              class="absolute inset-y-0 left-0 rounded-full"
              style="width: {(cur.d * 100).toFixed(1)}%; background: {cur.d >= dOn
                ? 'var(--color-hp)'
                : cur.d >= dOff
                  ? 'var(--color-ambre)'
                  : 'var(--color-muted-fg)'};"
            ></div>
            <div
              class="absolute inset-y-0"
              style="left: {(dOff * 100).toFixed(
                1
              )}%; width: 2px; background: var(--color-muted-fg); opacity: 0.6;"
            ></div>
            <div
              class="absolute inset-y-0"
              style="left: {(dOn * 100).toFixed(
                1
              )}%; width: 2px; background: var(--color-hp); opacity: 0.8;"
            ></div>
          </div>
          <div class="flex justify-between text-[10px]" style="color: var(--color-muted-fg);">
            <span>0</span>
            <span>éteint ↓{dOff.toFixed(2)} · ↑{dOn.toFixed(2)} allume</span>
            <span>1</span>
          </div>
        </div>

        <p class="text-[13px] leading-snug" style="color: var(--color-muted-fg);">
          {cur.reason}
        </p>
      </section>

      <!-- ── Batterie : moyenne + PLANCHER (le gate d'écrêtage) ── -->
      <section
        class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-5"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span class="text-[14px] font-semibold">Batterie & cuve</span>
        <div class="grid grid-cols-2 gap-4">
          <div class="flex flex-col gap-0.5">
            <span
              class="text-[11px] tracking-[0.06em] uppercase"
              style="color: var(--color-muted-fg);">SoC moyen</span
            >
            <span class="text-2xl font-bold tabular-nums">{cur.socPct}%</span>
          </div>
          <div class="flex flex-col gap-0.5">
            <span
              class="text-[11px] tracking-[0.06em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              SoC plancher
            </span>
            <span
              class="text-2xl font-bold tabular-nums"
              style="color: {cur.socMinPct >= 95 ? 'var(--color-mandarine)' : 'inherit'};"
            >
              {cur.socMinPct}%
            </span>
          </div>
        </div>
        <p class="text-[12px] leading-snug" style="color: var(--color-muted-fg);">
          L'écrêtage n'est possible que si le pack le <strong>moins plein</strong> est plein (plancher
          ≥ 95 %). C'est lui qui ouvre la voie « écrêtage », pas la moyenne.
        </p>
        <div
          class="flex items-center justify-between border-t pt-3 text-[13px]"
          style="border-color: var(--color-border);"
        >
          <span style="color: var(--color-muted-fg);">Énergie cuve</span>
          <span class="font-semibold tabular-nums"
            >{(cur.eAvailWh / 1000).toFixed(1)} kWh · {(cur.eAvailWh / 2000).toFixed(1)} douches</span
          >
        </div>
        <div class="flex items-center justify-between text-[13px]">
          <span style="color: var(--color-muted-fg);">Réseau</span>
          <span
            class="font-semibold tabular-nums"
            style="color: {cur.gridPowerW > 120 ? 'var(--color-hp)' : 'var(--color-success)'};"
          >
            {cur.gridPowerW > 0 ? `+${cur.gridPowerW} W (import)` : `${cur.gridPowerW} W`}
          </span>
        </div>
      </section>

      <!-- ── Signaux (potentiomètres) ── -->
      <section
        class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-5 lg:col-span-2"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <div class="flex items-baseline justify-between">
          <span class="text-[14px] font-semibold">Les potentiomètres</span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);">
            surplus confirmé = max(écrêtage, don, charge) = <strong
              >{cur.freeSurplus.toFixed(2)}</strong
            >
          </span>
        </div>
        <div class="flex flex-col gap-2.5">
          {#each signaux as s (s.key)}
            <div class="flex flex-col gap-1">
              <div class="flex items-baseline justify-between text-[12px]">
                <span>{s.label}</span>
                <span class="font-semibold tabular-nums">{s.v.toFixed(2)}</span>
              </div>
              <div
                class="h-2 overflow-hidden rounded-full"
                style="background: color-mix(in oklch, var(--color-muted-fg) 15%, transparent);"
              >
                <div
                  class="h-full rounded-full"
                  style="width: {(s.v * 100).toFixed(0)}%; background: {s.color};"
                ></div>
              </div>
            </div>
          {/each}
        </div>
        <p class="text-[12px] leading-snug" style="color: var(--color-muted-fg);">
          D = fenêtre × place × surplus confirmé, puis vetos (import / compteur muet / cuisine).
          Tant que le surplus confirmé reste bas, le modèle attend — la batterie d'abord.
        </p>
      </section>

      <!-- ── Timeline D ── -->
      <section
        class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-5 lg:col-span-2"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <div class="flex items-baseline justify-between">
          <span class="text-[14px] font-semibold">Journée (D dans le temps)</span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);">
            {#if firstTs && lastTs}{fmtTime(firstTs)} → {fmtTime(lastTs)}{/if}
          </span>
        </div>
        <div class="w-full overflow-x-auto">
          <svg
            viewBox="0 0 {W} {H}"
            class="h-28 w-full"
            preserveAspectRatio="none"
            role="img"
            aria-label="Courbe de désirabilité D"
          >
            <!-- seuils -->
            <line
              x1={PAD}
              x2={W - PAD}
              y1={y(dOn)}
              y2={y(dOn)}
              stroke="var(--color-hp)"
              stroke-width="1"
              stroke-dasharray="3 3"
              opacity="0.6"
            />
            <line
              x1={PAD}
              x2={W - PAD}
              y1={y(dOff)}
              y2={y(dOff)}
              stroke="var(--color-muted-fg)"
              stroke-width="1"
              stroke-dasharray="3 3"
              opacity="0.5"
            />
            <!-- aire + courbe D -->
            {#if dArea}
              <path
                d={dArea}
                fill="color-mix(in oklch, var(--color-glow) 22%, transparent)"
                stroke="none"
              />
            {/if}
            {#if dPath}
              <path
                d={dPath}
                fill="none"
                stroke="var(--color-glow-bright)"
                stroke-width="1.5"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
            {/if}
            <!-- marqueurs aurait=ON -->
            {#each onDots as p, i (i)}
              <circle cx={p.x} cy={p.y} r="2.2" fill="var(--color-hp)" />
            {/each}
          </svg>
        </div>
        <div
          class="flex flex-wrap items-center justify-between gap-2 text-[11px]"
          style="color: var(--color-muted-fg);"
        >
          <span
            ><span style="color: var(--color-hp);">— —</span> seuil d'allumage {dOn.toFixed(2)} ·
            <span style="color: var(--color-hp);">●</span> aurait chauffé</span
          >
          <span class="font-semibold">
            {#if cumulusShadow.wouldOnCount > 0}
              aurait chauffé ~{wouldOnMin} min · pic D {cumulusShadow.dPeak.toFixed(2)}
            {:else}
              aucune chauffe sur la fenêtre · pic D {cumulusShadow.dPeak.toFixed(2)}
            {/if}
          </span>
        </div>
      </section>
    </div>

    <p class="px-1 text-[11px] leading-relaxed" style="color: var(--color-muted-fg);">
      Le modèle « shadow » calcule et journalise, mais <strong>ne commande jamais le relais</strong>
      : le cumulus reste piloté par la logique en service. Ce banc sert à comparer, sur plusieurs jours,
      ce que le modèle <em>aurait</em> fait au réel avant toute décision. Fenêtre ~4 h · dernier
      tick {fmtTime(cumulusShadow.lastTickTs)}.
    </p>
  {/if}
</div>
