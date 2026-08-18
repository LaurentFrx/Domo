<script lang="ts">
  import { apsloop } from '$stores/apsloop.svelte';
  import { haptic } from '$utils/haptic';
  import { peutToutRegler, RESERVE } from '$utils/droits.svelte';

  // Tuile « bridage onduleur » : la boucle qui abaisse le plafond de l'onduleur
  // APS quand le compteur voit une injection persistante, et le rend dès que le
  // réseau redevient propre. Interrupteur + bascule observation/réel + état.
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

  const MODE_LABELS: Record<string, string> = {
    failsafe: 'Compteur muet — plafond rendu',
    night: 'Onduleur endormi',
    import: 'Soutirage — plafond rendu',
    throttle: 'Bridage en cours',
    raise: 'Remontée en cours',
    hold: 'En attente'
  };

  const obs = $derived(apsloop.obs);
  const last = $derived(apsloop.last);

  const stateLabel = $derived.by(() => {
    if (!apsloop.connected) return 'État inconnu';
    if (!apsloop.enabled)
      return apsloop.autoDisabledReason ? 'Désactivée (sécurité)' : 'Désactivée';
    if (!apsloop.tickAlive) return 'Activée — tick muet ⚠';
    if (apsloop.observationMode) return 'Observation — ne commande rien';
    return MODE_LABELS[last?.mode ?? ''] ?? (apsloop.throttled ? 'Bridage actif' : 'Surveille');
  });

  const dotColor = $derived.by(() => {
    if (!apsloop.connected || !apsloop.enabled) return 'var(--color-muted-fg)';
    if (apsloop.autoDisabledReason || !apsloop.tickAlive) return 'var(--color-hp)';
    if (apsloop.observationMode) return 'var(--color-muted-fg)';
    return apsloop.throttled ? 'var(--color-hc)' : 'var(--color-battery)';
  });

  const hhmm = (ts: number) =>
    new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  function toggle() {
    haptic('medium');
    void apsloop.setEnabled(!apsloop.enabled);
  }
  function toggleObservation() {
    haptic('light');
    void apsloop.setObservation(!apsloop.observationMode);
  }
</script>

<section
  class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
  aria-label="Bridage de l'onduleur pour éviter l'injection réseau"
>
  <!-- En-tête : titre + interrupteur -->
  <div class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 flex-col gap-0.5">
      <div class="flex items-center gap-2">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {dotColor};"></span>
        <span class="text-[14px] font-semibold">Bridage onduleur · anti-injection</span>
      </div>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        Baisse la production des panneaux du garage quand le surplus part chez EDF
      </span>
    </div>
    <button
      type="button"
      onclick={toggle}
      disabled={apsloop.busy || !apsloop.connected || !peutToutRegler()}
      title={peutToutRegler() ? undefined : RESERVE}
      class="rounded-full px-3 py-1.5 text-[12px] font-semibold transition-opacity disabled:opacity-40"
      style="background: {apsloop.enabled
        ? 'var(--color-battery-muted)'
        : 'var(--color-muted)'}; color: {apsloop.enabled
        ? 'var(--color-battery)'
        : 'var(--color-muted-fg)'};"
    >
      {apsloop.enabled ? 'Active' : 'Inactive'}
    </button>
  </div>

  <!-- État courant -->
  <div class="flex flex-col gap-1 text-[12px]" style="color: var(--color-muted-fg);">
    <span class="flex justify-between gap-2">
      <span>État</span>
      <span class="text-right font-medium" style="color: var(--color-fg);">{stateLabel}</span>
    </span>
    {#if apsloop.autoDisabledReason}
      <span class="text-[11px]" style="color: var(--color-hp);">
        ⚠ {apsloop.autoDisabledReason} — réactiver après vérification
      </span>
    {/if}
    {#if obs}
      <span class="flex justify-between gap-2">
        <span>Plafond onduleur</span>
        <span
          class="tabular-nums"
          style="color: {apsloop.throttled ? 'var(--color-hc)' : 'var(--color-fg)'};"
        >
          {nf0.format(obs.capW)} W {apsloop.throttled
            ? `(max ${nf0.format(obs.maxLimitW)} W)`
            : '· au maximum'}
        </span>
      </span>
      <span class="flex justify-between gap-2">
        <span>Réseau · onduleur</span>
        <span class="tabular-nums" style="color: var(--color-fg);">
          {obs.gridW < 0
            ? `${nf0.format(-obs.gridW)} W injectés`
            : `${nf0.format(obs.gridW)} W soutirés`}
          · {nf0.format(obs.apsW)} W
        </span>
      </span>
    {/if}
    {#if last}
      <span class="flex justify-between gap-2">
        <span>Dernière décision</span>
        <span class="max-w-[70%] truncate text-right" title={last.reason}
          >{hhmm(last.ts)} · {last.reason}</span
        >
      </span>
    {/if}
  </div>

  <!-- Bascule observation / réel : visible seulement quand la boucle tourne -->
  {#if apsloop.enabled}
    <button
      type="button"
      onclick={toggleObservation}
      disabled={apsloop.busy || !peutToutRegler()}
      title={peutToutRegler() ? undefined : RESERVE}
      class="flex items-center justify-between gap-3 rounded-[var(--radius-xl)] border px-3 py-2 text-left transition-opacity disabled:opacity-40"
      style="border-color: var(--color-border);"
    >
      <span class="flex min-w-0 flex-col">
        <span class="text-[12px] font-medium" style="color: var(--color-fg);">
          {apsloop.observationMode ? 'Observation' : 'Pilotage réel'}
        </span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">
          {apsloop.observationMode
            ? 'Journalise ce qu’elle ferait, sans toucher à l’onduleur'
            : 'Commande vraiment le plafond de l’onduleur'}
        </span>
      </span>
      <span
        class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold"
        style="background: {apsloop.observationMode
          ? 'var(--color-muted)'
          : 'var(--color-hc-muted)'}; color: {apsloop.observationMode
          ? 'var(--color-muted-fg)'
          : 'var(--color-hc)'};"
      >
        {apsloop.observationMode ? 'Passer en réel' : 'Repasser en observation'}
      </span>
    </button>
  {/if}

  <!-- Mini-journal (5 dernières décisions notables) -->
  {#if apsloop.decisions.length > 1}
    <div
      class="flex flex-col gap-1 border-t pt-2 text-[11px]"
      style="border-color: var(--color-border); color: var(--color-muted-fg);"
    >
      {#each apsloop.decisions.slice(1, 6) as d (d.ts)}
        <span class="truncate" title={d.reason}>
          {hhmm(d.ts)} · {d.writtenW !== null
            ? `${nf0.format(d.maxW)} → ${nf0.format(d.writtenW)} W${d.confirmedW !== null ? ' ✓' : ''}`
            : (MODE_LABELS[d.mode] ?? d.mode)} — {d.reason}
        </span>
      {/each}
    </div>
  {/if}
</section>
