const CACHE_NAME = 'gpx-tracker-v4';
const ASSETS = [
'./',
'./index.html', 
'./manifest.json',
'./icon-192.png',
'./icon-512.png',
'./icon-maskable-512.png',
'./css/style.css',
'./js/script.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).catch((err) => {
      console.error('Service worker install failed:', err);
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
          return undefined;
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Runtime caching (Cache-First with Network Fallback & Dynamic Saving)
self.addEventListener('fetch', (e) => {
	if (e.request.method !== 'GET') return;
	if (!e.request.url.startsWith('http')) return;
	
	e.respondWith(
		caches.match(e.request, { ignoreSearch: false }).then((cachedRes) => {
		if (cachedRes) {
			return cachedRes;
		}
		return fetch(e.request).then((networkRes) => {
			if (!networkRes || networkRes.status !== 200 || networkRes.type !== 'basic') {
				return networkRes;
			}
			
			// Dynamically cache same-origin GET requests only, to avoid unbounded growth.
			// Cross-origin or opaque responses are returned without caching.
			try {
				const url = new URL(e.request.url);
				if (url.origin !== self.location.origin) {
					return networkRes;
				}
			} catch {
				return networkRes;
			}
			const resClone = networkRes.clone();
			caches.open(CACHE_NAME).then((cache) => {
				cache.put(e.request, resClone);
				// Best-effort cap: trim dynamic entries so long sessions don't blow quota.
				cache.keys().then((keys) => {
					if (keys.length > 60) {
						cache.delete(keys[0]);
					}
				});
			});
			return networkRes;
		}).catch(() => {
			// Offline fallback: serve cached app shell for navigations.
			if (e.request.mode === 'navigate') {
				return caches.match('./index.html').then((fallback) => {
					if (fallback) return fallback;
					return new Response('Offline', { status: 503, statusText: 'Offline' });
				});
			}
			return new Response('Offline', { status: 503, statusText: 'Offline' });
		});
		})
	);
});
