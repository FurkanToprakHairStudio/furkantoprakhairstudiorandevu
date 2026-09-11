/**
 * =====================================================================
 *  Servis Görevlisi — bildirimleri karşılar
 * =====================================================================
 *  Sayfa kapalıyken bile çalışır. Tarayıcı bir bildirim alınca bu dosyayı
 *  uyandırır, burası da bildirimi ekrana basar.
 *
 *  Gelen mesaj CİHAZA ÖZEL anahtarla şifrelenmiştir; tarayıcı burada çözer.
 *  Aradaki hiçbir sunucu içeriği okuyamaz.
 */

// Yeni sürüm yüklenince beklemeden devreye gir
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (olay) => olay.waitUntil(self.clients.claim()));

self.addEventListener('push', (olay) => {
  let veri = {};
  try { veri = olay.data ? olay.data.json() : {}; }
  catch { veri = {}; }

  const baslik = veri.baslik || 'Randevu';
  const secenekler = {
    body: veri.govde || '',
    icon: 'simge-192.png',
    badge: 'simge-192.png',
    lang: 'tr',
    // Etiket verilmiyor: her randevu ayrı bildirim olarak dursun,
    // üst üste gelenler birbirini ezmesin.
    requireInteraction: false,
    data: { adres: veri.adres || './' }
  };
  olay.waitUntil(self.registration.showNotification(baslik, secenekler));
});

self.addEventListener('notificationclick', (olay) => {
  olay.notification.close();
  const adres = (olay.notification.data && olay.notification.data.adres) || './';
  olay.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((pencereler) => {
        // Site zaten açıksa onu öne getir, değilse yeni sekmede aç
        for (const p of pencereler) {
          if ('focus' in p) return p.focus();
        }
        return self.clients.openWindow(adres);
      })
  );
});
