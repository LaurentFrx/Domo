<script lang="ts">
  import '../app.css';
  import TabBar from '$components/layout/TabBar.svelte';

  let { children } = $props();
</script>

<div class="flex min-h-screen flex-col">
  <main class="safe-top flex-1 overflow-y-auto">
    <div class="mx-auto max-w-2xl px-4">
      {@render children()}
    </div>
  </main>
  <TabBar />
</div>
