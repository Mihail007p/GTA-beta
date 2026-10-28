// Service worker: игра работает без интернета после первого открытия.
// Стратегия: отдаём из кэша мгновенно, в фоне обновляем файл с сервера.
// Кэши привязаны к области приложения: на общих хостингах нельзя удалять
// файлы других проектов или других установок игры.
const CACHE_VERSION = 'v11';
const CACHE_PREFIX = `openstreet:${self.registration.scope}:`;
const CACHE = CACHE_PREFIX + CACHE_VERSION;
const FILES = [
  // Не запрашиваем саму папку: Raw.githack отдаёт только конкретные файлы.
  './index.html', './css/style.css', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './vendor/three.js', './vendor/THREE-LICENSE.txt',
  './js/main.js', './js/config.js', './js/rng.js', './js/city.js', './js/car-physics.js', './js/cars.js',
  './js/collision.js', './js/traffic.js', './js/gameplay.js', './js/save.js', './js/textures.js',
  './js/car-model.js', './js/renderer.js', './js/audio.js', './js/input.js', './js/ui.js', './js/traffic-types.js',
  './js/characters.js', './js/pedestrian.js', './js/vehicles.js', './js/foot-input.js', './js/hero-model.js',
  './vendor/GLTFLoader.js', './vendor/BufferGeometryUtils.js', './vendor/meshopt_decoder.module.js',
  // модели (~3.4 МБ): машины гаража и трафик — чтобы гараж работал и без интернета
  './assets/cars/cayenne.glb', './assets/cars/gt3.glb', './assets/cars/f458.glb', './assets/cars/cgt.glb',
  './assets/traffic.glb',
  './assets/characters/hero-1.glb', './assets/characters/hero-2.glb', './assets/characters/motion.json',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    let hit = await cache.match(req, { ignoreSearch: true });
    // На обычном сервере игра также открывается по /game/; для офлайна
    // используем закэшированный index.html, не требуя листинга папки.
    if (!hit && req.mode === 'navigate' && new URL(req.url).pathname === new URL(self.registration.scope).pathname) {
      hit = await cache.match(new URL('index.html', self.registration.scope).href);
    }
    const net = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('offline', { status: 503 });
  }));
});
