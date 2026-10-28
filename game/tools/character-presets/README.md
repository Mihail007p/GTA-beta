# Исходные настройки героев

`hero-1.json` и `hero-2.json` — пресеты HumanGenWeb; не нужны для запуска игры.
Исходная версия HumanGenWeb: [`a8ee33f96791ed15534246ac88cc8b20f9da8f6a`](https://github.com/NastyFFM/HumanGenWeb/tree/a8ee33f96791ed15534246ac88cc8b20f9da8f6a).
Происхождение и лицензии данных описаны в [`../../assets/characters/README.md`](../../assets/characters/README.md).

## Пересборка модели

1. В отдельной рабочей папке получите указанную ревизию HumanGenWeb. Примените
   `humangen-export.patch` к её `app.js`: он отбрасывает отрицательные веса
   кожи и не записывает служебные квадраты в GLB. Он предназначен для указанной ревизии.
2. Запустите HumanGenWeb через локальный HTTP-сервер, откройте его в браузере,
   загрузите `hero-1.json` или `hero-2.json` через **Load preset** и дождитесь
   загрузки целей, одежды, рига и текстур. Экспортируйте **Download GLB**.
   HumanGenWeb в оригинальной конфигурации загружает Three.js через CDN; для
   разработки без CDN можно подставить локальную копию Three.js 0.170.0.
3. В этой директории выполните `npm install`, затем, подставив свои пути:

   ```sh
   npx gltf-transform optimize human.glb hero.glb \
     --compress meshopt --texture-compress webp --texture-size 1024 \
     --simplify false --flatten false --join false
   ```

   Использованы CLI 4.2.1 и glTF-Transform core 4.5.1. Обязательно проверьте
   результат на отрицательные веса и в игровой сцене: экспорт браузера,
   изображения, версии зависимостей и время загрузки могут повлиять на файл.
   Игра масштабирует рост в `js/characters.js`, анимации применяются отдельно.

## Пересборка движения

1. Получите исходные BVH: [`data/007/07_01.bvh`](https://github.com/una-dinosauria/cmu-mocap/blob/09a07f54f3bbb58797325f009282d0b2048a2871/data/007/07_01.bvh)
   (ходьба) и [`data/009/09_01.bvh`](https://github.com/una-dinosauria/cmu-mocap/blob/09a07f54f3bbb58797325f009282d0b2048a2871/data/009/09_01.bvh)
   (бег). Оригинальные файлы в игру не включены.
2. После `npm install` запустите:

   ```sh
   node build-motion.mjs /путь/07_01.bvh /путь/09_01.bvh /путь/motion.json
   ```

Скрипт возвращает те же числовые данные, что и игровой `motion.json` (формат
записи чисел может отличаться). Ходьба — исходные кадры 101–230, бег — 11–98;
сохранён каждый четвёртый кадр. В `js/hero-model.js` отдельно настраиваются
локальные кости, положение рук и idle; бинарные модели не содержат клипов.
