# FootBot

Мобильное PWA для подбора кроссовок по фото стопы.

**Живая версия: https://kirill-code.github.io/FootBot/**

## Стек

- Vite + React 19 + TypeScript (strict)
- `react-router` (HashRouter — для деплоя на GitHub Pages)
- `vite-plugin-pwa` (Workbox, `registerType: 'autoUpdate'`)
- `dexie` + `dexie-react-hooks` (IndexedDB: фото стоп, замеры)
- `@techstark/opencv-js` — измерение стопы по фото (ленивый чанк, грузится только при сканировании)

## Команды

```bash
npm install      # установка зависимостей
npm run dev      # дев-сервер
npm run build    # тип-проверка (tsc -b) + сборка в dist/
npm run preview  # предпросмотр сборки
npm test         # unit-тесты скоринга (vitest, однократный прогон)
npx vitest       # тесты в watch-режиме
```

## Структура

```
src/
  app/        App (HashRouter, роуты), Layout (нижняя мобильная навигация), HomePage
  camera/     ScanPage — заглушка сканирования (input type=file capture=environment)
  profile/    db.ts (Dexie: photos, measurements), ProfilePage
  catalog/    types.ts (ShoeModel, SizeEntry), catalogApi.ts, страницы каталога
  matching/   scoring.ts (scoreModel — чистая функция скоринга),
              profile.ts (UserProfile: замеры из Dexie + настройки из localStorage),
              RecommendationsPage, scoring.test.ts (unit-тесты скоринга)
  ui/         ShoeCard
public/
  catalog/catalog.json   каталог из 20 моделей (топ 2024–2026)
  catalog/images/        фото моделей, webp ~1000px (см. ATTRIBUTION.md)
  catalog/ATTRIBUTION.md источники фото, авторы и лицензии
  icons/                 иконки PWA (генерируются tools/generate-icons.mjs)
tools/
  generate-icons.mjs     генератор PNG-иконок без зависимостей
  build-catalog.mjs      генератор catalog.json из таблицы моделей и сеток
  validate-catalog.mjs   проверка каталога (JSON, монотонность сетки, фото)
  fetch-catalog-images.py / refill-catalog-images.py  загрузка фото через Openverse
  attribution.json       манифест источников фото (URL, автор, лицензия)
```

## Каталог (public/catalog/)

`catalog.json` — массив моделей по интерфейсу `ShoeModel` (`src/catalog/types.ts`):
`id` (slug), `brand`, `name`, `purpose`, `fit`, `last`, `fitAdjustment`,
`sizeChart` (массив `SizeEntry`: `us`, `uk`, `eu`, `footLengthMm`), `image`,
`priceUsd`, `description`. Размерные сетки — по официальным данным брендов:
Nike/Jordan/NB/Puma/Vans/Onitsuka (шаг 10 мм, US8 = 260 мм), Adidas (+5 мм
смещение), Asics и Salomon (полуразмеры), Converse (маломерят, −1 поправка).

### Как добавить модель

1. Добавьте вызов `m(...)` в массив `catalog` в `tools/build-catalog.mjs`
   (используйте готовые сетки `nike()`/`adidas()`/`chart(...)` или добавьте новую).
2. Положите фото `public/catalog/images/<slug>.webp` (800–1200 px, ≤150 КБ).
3. Запишите источник/автора/лицензию в `public/catalog/ATTRIBUTION.md`
   (и при загрузке через Openverse — в `tools/attribution.json`).
   Используйте только фото с коммерчески совместимыми лицензиями
   (CC0, CC BY, CC BY-SA, Unsplash License) и обязательно указывайте автора.
4. Запустите `node tools/build-catalog.mjs && node tools/validate-catalog.mjs`.

### Лицензии фото

Все 20 фото — реальные, найдены через [Openverse](https://openverse.org) на
Wikimedia Commons и Flickr с коммерчески совместимыми лицензиями: CC0 1.0,
CC BY 4.0, CC BY-SA 4.0. Полный список «модель → файл → источник → автор →
лицензия» — в `public/catalog/ATTRIBUTION.md`, при повторном использовании
каталога атрибуцию сохранять обязательно. Две оговорки (помечены там же):
у `puma-palermo` фото близкой модели Puma Easy Rider, у `salomon-xt-6` —
трейловых Salomon Speedcross (фото именно XT-6 в открытых источниках не нашлось).

## Деплой (GitHub Pages)

Сборка производится с `base: './'`, роутинг — на HashRouter, поэтому
достаточно опубликовать содержимое `dist/` (например, через GitHub Actions
на ветку `gh-pages`). В настройках репозитория включите Pages с источником
`gh-pages` / root.

## Метрики подбора (src/matching/scoring.ts)

Подбор строится на профиле пользователя `UserProfile` (`src/matching/profile.ts`):
длина/ширина стопы берутся из последнего замера в Dexie (fallback — localStorage,
в т.ч. ручной ввод на экране «Подбор»), полнота, назначение и предпочтение
посадки — из настроек.

```
Score = 100 * (0.45*S_length + 0.25*S_width + 0.15*S_last + 0.15*S_purpose)
S_length = max(0, 1 - |L_in(US_final) - L - allowance| / 10), allowance = 10 мм
S_width / S_last: 1 — совпадение, 0.5 — соседние, 0 — противоположные
S_purpose: 1 — совпадение, 0.5 — пересечение (casual ↔ running/basketball/trail и др.), 0.2 — нет
verdict: ≥85 perfect («ваш размер»), ≥70 good («с нюансами»), иначе poor (серый)
```

Рекомендуемый размер: `US* = argmin по sizeChart |footLengthMm - (L + 10 мм)|`,
затем поправка `fitAdjustment` модели, затем ближайший имеющийся размер сетки
(полуразмеры поддерживаются; при равной дистанции выбирается меньший размер).
В карточке модели строка с рекомендуемым размером подсвечивается в сетке.

Дисклеймер, показываемый пользователю: «Подбор по длине не учитывает полноту
и подъём — рекомендуем примерку».

## Тесты

Unit-тесты скоринга — `src/matching/scoring.test.ts` (vitest): точное попадание,
граничное «между размерами», большое несовпадение длины, широкая стопа +
узкая колодка, несовпадение назначения, `fitAdjustment −1` (Converse),
полуразмеры в сетке, пустая сетка.

```bash
npm test         # однократный прогон
npx vitest       # watch-режим
```
