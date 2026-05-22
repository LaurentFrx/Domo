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
    }
  }
};

export default config;
