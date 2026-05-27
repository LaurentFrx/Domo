<script lang="ts">
  import { untrack } from 'svelte';

  interface Props {
    value: number;
    decimals?: number;
    duration?: number;
    suffix?: string;
    prefix?: string;
    class?: string;
  }

  let {
    value,
    decimals = 0,
    duration = 600,
    suffix = '',
    prefix = '',
    class: klass = ''
  }: Props = $props();

  let displayed = $state(untrack(() => value));
  let rafId = 0;

  $effect(() => {
    const target = value;
    const start = displayed;
    const delta = target - start;

    if (delta === 0) return;

    const t0 = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      displayed = start + delta * eased;
      if (progress < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        displayed = target;
      }
    };

    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  });

  const formatted = $derived(displayed.toFixed(decimals));
</script>

<span class={klass}>{prefix}{formatted}{suffix}</span>
