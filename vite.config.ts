import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'dist/**', 'tools/**']
  },
  base: './',
  // Классические (iife) workers: динамические импорты инлайнятся в чанк
  // worker'а (opencv 15.5МБ в measureWorker — тот же объём загрузки,
  // на один запрос меньше).
  worker: {
    format: 'iife',
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'FootBot',
        short_name: 'FootBot',
        description: 'Подбор кроссовок по фото стопы',
        display: 'standalone',
        background_color: '#111111',
        theme_color: '#111111',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // OpenCV (~15 МБ) не прекешируем: грузится лениво при первом скане
        // и кешируется runtime-стратегией ниже.
        globIgnores: ['**/opencv-*.js', '**/measureWorker-*.js'],
        runtimeCaching: [
          {
            // OpenCV.js — тяжёлый ленивый чанк, хеш в имени меняется от сборки к сборке
            urlPattern: /\/assets\/(?:opencv|measureWorker)-[^/]+\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opencv',
              expiration: {
                maxEntries: 2,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 дней
              }
            }
          },
          {
            // Фото моделей из каталога — тяжёлые, редко меняются
            urlPattern: /\/catalog\/images\/.*\.(?:png|jpg|jpeg|webp|avif)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'catalog-images',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 дней
              }
            }
          }
        ]
      }
    })
  ],
  build: {
    target: 'esnext'
  }
})
