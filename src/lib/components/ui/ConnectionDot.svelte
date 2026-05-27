<script lang="ts">
  type Status = 'connected' | 'connecting' | 'disconnected' | 'mock';

  interface Props {
    status: Status;
  }

  let { status }: Props = $props();

  const color = $derived(
    status === 'connected'
      ? 'var(--accent-500)'
      : status === 'connecting'
        ? 'var(--warning)'
        : status === 'mock'
          ? 'var(--primary-400)'
          : 'var(--error)'
  );

  const label = $derived(
    status === 'connected'
      ? 'Connecté'
      : status === 'connecting'
        ? 'Connexion…'
        : status === 'mock'
          ? 'Démo'
          : 'Hors ligne'
  );
</script>

<div
  class="inline-flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-[var(--text-secondary)]"
>
  <span
    class="relative inline-block h-2 w-2 rounded-full"
    class:dot-ping={status === 'connecting'}
    style="background-color: {color}; color: {color};"
  ></span>
  <span>{label}</span>
</div>
