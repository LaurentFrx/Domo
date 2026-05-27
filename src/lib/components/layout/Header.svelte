<script lang="ts">
  import { formatDate } from '$utils/format';
  import { dashboard } from '$stores/dashboard.svelte';
  import ConnectionDot from '$components/ui/ConnectionDot.svelte';

  interface Props {
    name?: string;
  }

  let { name = 'Laurent' }: Props = $props();

  const date = $derived(formatDate());
</script>

<header class="flex flex-col gap-1 pt-4 pb-2">
  <div class="flex items-center justify-between">
    <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">{date}</span>
    <ConnectionDot status={dashboard.connectionStatus} />
  </div>
  <h1 class="text-2xl font-medium text-white">Bonjour {name}</h1>
</header>
