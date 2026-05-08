<script lang="ts">
  import { formatDate } from '$utils/format';

  interface Props {
    name?: string;
  }

  let { name = 'Laurent' }: Props = $props();

  const date = $derived(formatDate());
</script>

<header class="flex flex-col gap-1 pt-4 pb-2">
  <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">{date}</span>
  <h1 class="text-2xl font-medium text-white">Bonjour {name}</h1>
</header>
