const CACHE_NAME = 'gpx-tracker-v3';
const ASSETS = [
'./index.html', 
'./manifest.json',
'./icon-192.png',
'./css/style.css',
'./js/script.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Runtime caching (Cache-First with Network Fallback & Dynamic Saving)
self.addEventListener('fetch', (e) => {
	if (!e.request.url.startsWith('http')) return;
	
	e.respondWith(
		caches.match(e.request).then((cachedRes) => {
		if (cachedRes) {
			return cachedRes;
		}
		return fetch(e.request).then((networkRes) => {
			if (!networkRes || networkRes.status !== 200 || networkRes.type !== 'basic') {
				return networkRes;
			}
			
			// Dynamically cache any new successful requests (like icons or chunks)
			return caches.open(CACHE_NAME).then((cache) => {
			cache.put(e.request, networkRes.clone());
			return networkRes;
			});
		}).catch(() => {
			console.warn('Network request failed and no cache available for:', e.request.url);
		});
		})
	);
});