<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import Sidebar from '$components/layout/Sidebar.svelte';
  import TabBar from '$components/layout/TabBar.svelte';
  import { startDemoTicker, stopDemoTicker } from '$stores/demo-ticker.svelte';

  let { children } = $props();

  $effect(() => {
    startDemoTicker();
    return () => stopDemoTicker();
  });
</script>

<div class="min-h-screen">
  <Sidebar />

  <main class="safe-top min-h-screen pb-24 md:pb-6 md:pl-20">
    <div class="mx-auto w-full max-w-screen-xl px-3 md:px-6">
      {#key page.url.pathname}
        <div class="animate-[slide-up-fade_0.25s_ease-out]">
          {@render children()}
        </div>
      {/key}
    </div>
  </main>

  <TabBar />
</div>
