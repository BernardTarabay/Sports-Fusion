import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Sports Fusion',
        short_name: 'Sports Fusion',
        description: 'Find a game. Join your district. Meet your team. Play.',
        theme_color: '#0A0F0D',
        background_color: '#0A0F0D',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Separate file, not the same one relabelled. Android and iOS crop a maskable
          // icon to a circle or squircle and only guarantee the middle 80%, so this one
          // is inset by 10% on every side. Pointing both purposes at an edge-to-edge
          // image is how logos end up with their sides shaved off on a home screen.
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The API is cookie-authenticated and changes constantly. Never serve a cached
        // roster -- a player looking at 21/22 who is actually on the waitlist is worse
        // than a spinner.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],

  server: {
    port: 5173,
    proxy: {
      // Same-origin in development so the httpOnly session cookie is sent without CORS
      // gymnastics, and so nothing is tempted to put a token in localStorage.
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },

  build: {
    target: 'es2022',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing vendors so a UI tweak does not invalidate the
        // whole bundle for returning players on a Beirut mobile connection.
        //
        // Vite 8 runs Rolldown, which takes manualChunks as a function rather than a map.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) {
            return 'react';
          }
          if (id.includes('@tanstack')) return 'query';
          if (/[\\/]node_modules[\\/]motion/.test(id)) return 'motion';
          if (id.includes('@radix-ui')) return 'radix';
          return undefined;
        },
      },
    },
  },
});
