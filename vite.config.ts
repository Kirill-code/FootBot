import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'dist/**', 'tools/**']
  },
  base: './',
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
        globIgnores: ['**/opencv-*.js', '**/mediapipe/**'],
        runtimeCaching: [
          {
            // mediapipe wasm — self-hosted в public/, крупные файлы
            urlPattern: /\/mediapipe\/.*\.(?:js|wasm)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mediapipe-wasm',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 30
              }
            }
          },
          {
            // Модель NN-сегментации — с CDN Google, 17 МБ, редко меняется
            urlPattern: /https:\/\/storage\.googleapis\.com\/mediapipe-models\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'nn-model',
              expiration: {
                maxEntries: 4,
                maxAgeSeconds: 60 * 60 * 24 * 30
              }
            }
          },
          {
            // OpenCV.js — тяжёлый ленивый чанк, хеш в имени меняется от сборки к сборке
            urlPattern: /\/assets\/opencv-[^/]+\.js$/,
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
