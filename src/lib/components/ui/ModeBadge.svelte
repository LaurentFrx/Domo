<script lang="ts">
  import type { CumulusMode } from '$theme/tokens';
  import { modeColor } from '$theme/tokens';

  interface Props {
    mode: CumulusMode;
  }

  let { mode }: Props = $props();

  const bg = $derived(modeColor(mode));
</script>

<div
  class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
  style="background-color: {bg}; color: var(--surface-base);"
>
  <span class="h-1.5 w-1.5 rounded-full" style="background-color: var(--surface-base);"></span>
  Mode {mode}
</div>
