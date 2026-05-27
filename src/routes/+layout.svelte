<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import TabBar from '$components/layout/TabBar.svelte';
  import { startDemoTicker, stopDemoTicker } from '$stores/demo-ticker.svelte';

  let { children } = $props();

  $effect(() => {
    startDemoTicker();
    return () => stopDemoTicker();
  });
</script>

<div class="flex min-h-screen flex-col">
  <main class="safe-top flex-1 overflow-y-auto">
    <div class="mx-auto max-w-2xl px-4">
      {#key page.url.pathname}
        <div class="animate-[slide-up-fade_0.25s_ease-out]">
          {@render children()}
        </div>
      {/key}
    </div>
  </main>
  <TabBar />
</div>
