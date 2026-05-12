<script lang="ts">
  interface Props {
    /** Pourcentage 0-100 */
    value: number;
    color?: string;
  }

  let { value, color = 'var(--accent-500)' }: Props = $props();

  const clamped = $derived(Math.max(0, Math.min(100, value)));
</script>

<div class="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
  <div
    class="absolute top-0 left-0 h-full rounded-full transition-[width] duration-300 ease-out"
    style="width: {clamped}%; background-color: {color};"
  ></div>
</div>
