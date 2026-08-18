<script lang="ts">
  import { sb3loop } from '$stores/sb3loop.svelte';
  import { haptic } from '$utils/haptic';
  import { peutToutRegler, RESERVE } from '$utils/droits.svelte';

  // Tuile « boucle SB3 » : la boucle lente qui alloue l'énergie entre les
  // Solarbank 3 et la Max AC la nuit (consigne cloud, minutes, bandes mortes).
  // Interrupteur + dernière décision + santé + mini-journal. La boucle est
  // INACTIVE par défaut — activation explicite ici.
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

  const MODE_LABELS: Record<string, string> = {
    off: 'À l’arrêt',
    failsafe: 'Capteurs muets — gelée',
    faillow: 'Cloud douteux — repli bas',
    allocate: 'Répartition au prorata',
    hold: 'En attente (mode Anker)'
  };

  const last = $derived(sb3loop.last);
  const stateLabel = $derived.by(() => {
    if (!sb3loop.connected) return 'État inconnu';
    if (!sb3loop.enabled)
      return sb3loop.autoDisabledReason ? 'Désactivée (sécurité)' : 'Désactivée';
    if (!sb3loop.tickAlive) return 'Activée — tick muet ⚠';
    // Le cloud peut refuser les consignes alors que la boucle tourne : sans ce
    // test, la carte affichait « Active — dernier ordre 350 W » pendant qu'aucun
    // ordre n'était accepté.
    if (sb3loop.confirmFailCount > 2)
      return `Active — ordres non confirmés (${sb3loop.confirmFailCount})`;
    return MODE_LABELS[last?.mode ?? ''] ?? 'Active';
  });
  const dotColor = $derived.by(() => {
    if (!sb3loop.connected || !sb3loop.enabled) return 'var(--color-muted-fg)';
    if (sb3loop.autoDisabledReason || !sb3loop.tickAlive || sb3loop.confirmFailCount > 2)
      return 'var(--color-hp)';
    return 'var(--color-battery)';
  });

  const hhmm = (ts: number) =>
    new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  function toggle() {
    haptic('medium');
    void sb3loop.setEnabled(!sb3loop.enabled);
  }
</script>

<section
  class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
  aria-label="Boucle d'allocation des batteries Solarbank"
>
  <!-- En-tête : titre + interrupteur -->
  <div class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 flex-col gap-0.5">
      <div class="flex items-center gap-2">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {dotColor};"></span>
        <span class="text-[14px] font-semibold">Boucle batteries · nuit</span>
      </div>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        Chaque batterie donne au prorata de ce qu'elle peut encore fournir
      </span>
    </div>
    <button
      type="button"
      onclick={toggle}
      disabled={sb3loop.busy || !sb3loop.connected || !peutToutRegler()}
      title={peutToutRegler() ? undefined : RESERVE}
      class="rounded-full px-3 py-1.5 text-[12px] font-semibold transition-opacity disabled:opacity-40"
      style="background: {sb3loop.enabled
        ? 'var(--color-battery-muted)'
        : 'var(--color-muted)'}; color: {sb3loop.enabled
        ? 'var(--color-battery)'
        : 'var(--color-muted-fg)'};"
    >
      {sb3loop.enabled ? 'Active' : 'Inactive'}
    </button>
  </div>

  <!-- État + dernière décision -->
  <div class="flex flex-col gap-1 text-[12px]" style="color: var(--color-muted-fg);">
    <span class="flex justify-between gap-2">
      <span>État</span>
      <span class="text-right font-medium" style="color: var(--color-fg);">{stateLabel}</span>
    </span>
    {#if sb3loop.autoDisabledReason}
      <span class="text-[11px]" style="color: var(--color-hp);">
        ⚠ {sb3loop.autoDisabledReason} — réactiver après vérification
      </span>
    {/if}
    {#if sb3loop.lastCmdW !== null}
      <span class="flex justify-between gap-2">
        <span>Consigne posée</span>
        <span class="tabular-nums" style="color: var(--color-fg);"
          >{nf0.format(sb3loop.lastCmdW)} W{sb3loop.lastWriteTs
            ? ` · ${hhmm(sb3loop.lastWriteTs)}`
            : ''}</span
        >
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

  <!-- Mini-journal (5 dernières décisions notables) -->
  {#if sb3loop.decisions.length > 1}
    <div
      class="flex flex-col gap-1 border-t pt-2 text-[11px]"
      style="border-color: var(--color-border); color: var(--color-muted-fg);"
    >
      {#each sb3loop.decisions.slice(1, 6) as d (d.ts)}
        <span class="truncate" title={d.reason}>
          {hhmm(d.ts)} · {d.writtenW !== null
            ? `${nf0.format(d.beforeW ?? 0)} → ${nf0.format(d.writtenW)} W${d.confirmedW !== null ? ' ✓' : ' ✗'}`
            : (MODE_LABELS[d.mode] ?? d.mode)} — {d.reason}
        </span>
      {/each}
    </div>
  {/if}
</section>
