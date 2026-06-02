import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit(),
    SvelteKitPWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      strategies: 'generateSW',
      manifest: {
        name: 'Domo',
        short_name: 'Domo',
        description: 'Tableau de bord énergie de la maison Feroux',
        theme_color: '#07001F',
        background_color: '#07001F',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        lang: 'fr',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icons/icon-192-maskable.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['client/**/*.{js,css,ico,png,svg,woff,woff2}'],
        // navigateFallback ('/') ne doit JAMAIS court-circuiter ces routes une
        // fois la PWA installée (SW actif) : /auth pose le cookie de session
        // (sinon /denied perpétuel), /api/* sont des endpoints serveur (dont
        // /api/forecast), /denied est la page publique de refus.
        navigateFallbackDenylist: [/^\/auth/, /^\/api\//, /^\/denied/],
        // TODO: cache orchestrateur
        runtimeCaching: []
      },
      devOptions: {
        enabled: false
      }
    })
  ],
  server: {
    port: 5173,
    strictPort: false
  }
});
