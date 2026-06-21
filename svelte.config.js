import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      out: 'build',
      precompress: true,
      envPrefix: ''
    }),
    alias: {
      $components: 'src/lib/components',
      $theme: 'src/lib/theme',
      $stores: 'src/lib/stores',
      $utils: 'src/lib/utils'
    },
    // Détecte une nouvelle version déployée (sonde _app/version.json) → le client
    // recharge proprement (cf. beforeNavigate dans +layout) au lieu de charger des
    // chunks périmés/404 après un déploiement, ce qui « cassait » un onglet ouvert.
    version: {
      pollInterval: 60000
    }
  }
};

export default config;
