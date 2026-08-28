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
        // webp inclus : la bannière de l'Accueil (header-accueil.webp, 132 Ko) et
        // le fond du Sankey (lueur-verte.webp) étaient les SEULS visuels du
        // premier écran hors precache — retéléchargés après chaque déploiement.
        globPatterns: ['client/**/*.{js,css,ico,png,svg,webp,woff,woff2}'],
        // Sous-ensembles Inter jamais téléchargés par les pages (unicode-range,
        // UI 100 % française) : seul le precache les payait (~170 Ko).
        globIgnores: ['**/inter-cyrillic*', '**/inter-greek*', '**/inter-vietnamese*'],
        // Écarte le chunk three.js (828 Ko, page /maison seule) du precache : il
        // se charge au premier passage sur /maison et reste ensuite dans le
        // cache HTTP (immutable, 1 an). Le premier lancement PWA ne télécharge
        // plus ~1 Mo de 3D en concurrence avec les premières données.
        // Via manifestTransforms (et pas maximumFileSizeToCacheInBytes : le
        // plugin convertit l'avertissement « fichier trop gros » en ÉCHEC de
        // build — le nom du chunk étant hashé, impossible de le globIgnorer).
        manifestTransforms: [
          async (entries) => ({
            manifest: entries.filter((e) => e.size <= 600_000),
            warnings: []
          })
        ],
        // Greffe le handler Web Push (push + notificationclick) sur le SW généré,
        // SANS modifier la stratégie de cache. Le fichier est servi en statique.
        importScripts: ['/push-sw.js'],
        /**
         * PAS de navigateFallback (08/08/2026 — correctif d'un SW figé).
         *
         * Le défaut du plugin est `'/'`, qui produit
         * `createHandlerBoundToURL('/')` AU PREMIER NIVEAU du service worker.
         * Or cette app est en SSR (adapter-node) : `'/'` n'est JAMAIS dans le
         * precache — la fonction lève alors `non-precached-url` pendant
         * l'évaluation du script, et le service worker ÉCHOUE à s'installer.
         *
         * Conséquence vécue : le SW enregistré au moment d'activer les
         * notifications restait actif à vie, servait son precache d'origine, et
         * aucune version suivante ne pouvait le remplacer — l'app restait figée
         * sur un vieux bundle, déploiement après déploiement.
         *
         * Un repli de navigation n'a de toute façon pas de sens ici : les pages
         * sont rendues côté serveur et derrière authentification.
         */
        navigateFallback: undefined,
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
