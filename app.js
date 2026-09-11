/* =====================================================================
 *  Berber Randevu Sistemi — Frontend
 * =====================================================================
 *
 *  Bu dosyada SIR YOKTUR. Kaynağa bakan biri şunları BULAMAZ:
 *    - ntfy bildirim kanallarının adları
 *    - hizmet fiyatları
 *    - aylık sabit giderler
 *    - usta prim oranları
 *    - yönetici şifresi ya da anahtarı
 *  Hepsi backend'de durur ve yalnızca yetkili uçlardan döner.
 *
 *  Eskiden randevu defteri herkese açık bir MQTT broker'ındaydı ve müşteri
 *  verisi tarayıcıda şifrelenip çözülüyordu. Artık tek doğru kaynak sunucu.
 *  Bu yüzden şifreleme katmanı, kayıp önleyen birleştirme ve yerel arşiv
 *  tamamen kaldırıldı.
 * ===================================================================== */

// =====================================================================
//  TEK AYAR: BACKEND ADRESİ
//  wrangler deploy sonrası çıkan adresi buraya yaz. Sonunda / OLMAYACAK.
//  Örnek: https://furkanhair-api.kullaniciadi.workers.dev
// =====================================================================
const API_TEMEL = 'https://furkanhair-api.harmonyerp-api.workers.dev';

// ===== DURUM =====
const state = {
  // müşteri akışı
  selectedDate: null,
  selectedBarber: null,
  selectedTime: null,
  selectedServices: [],
  formReady: false,
  flatpickr: null,

  // sunucudan gelen açık veri
  ustalar: [],
  saatler: [],
  hizmetler: [],
  hizmetCakisma: [],
  kapaliGunler: [],
  bugun: '',
  turnstileAnahtari: null,

  // seçili günün doluluk bilgisi
  gunDurumu: { kapali: false, dolu: {}, gecmis: [] },

  // giriş yapan kişi
  jeton: null,
  isAdmin: false,          // giriş yapılmış mı
  kullanici: null,         // kullanıcı adı
  kullaniciAdi: null,      // görünen ad
  rol: null,               // 'yonetici' | 'usta'
  ustaId: null,            // usta rolündeyse hangi usta
  vapidAnahtari: null,     // bildirim için açık anahtar
  randevular: [],
  adminFilter: 'all'
};

/** Yönetici mi? Hesap defteri ve müşteri analizi yalnızca buna açık. */
const yoneticiMi = () => state.rol === 'yonetici';

// Oturum bilgisi cihazda kalıcı durur; yalnızca Çıkış Yap ile silinir.
const OTURUM_ANAHTARI = 'berber_oturum';

function oturumuKaydet(veri) {
  try { localStorage.setItem(OTURUM_ANAHTARI, JSON.stringify(veri)); } catch {}
}
function oturumuOku() {
  try { return JSON.parse(localStorage.getItem(OTURUM_ANAHTARI) || 'null'); } catch { return null; }
}
function oturumuSil() {
  try { localStorage.removeItem(OTURUM_ANAHTARI); } catch {}
}

// ===== KÜÇÜK YARDIMCILAR =====

function escHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatDateTR(s){
  if(!s) return '';
  const [y,m,d] = String(s).split('-');
  const aylar = 'Ocak Şubat Mart Nisan Mayıs Haziran Temmuz Ağustos Eylül Ekim Kasım Aralık'.split(' ');
  return `${parseInt(d)} ${aylar[parseInt(m)-1]} ${y}`;
}

/** Bugünün tarihi. Sunucudan gelir; tarayıcının saati ya da saat dilimi
 *  yanlışsa bile doğru çalışır. Eski sürüm burada UTC kullanıyordu ve
 *  akşam 21:00'den sonra günü bir ileri sayıyordu. */
function today(){ return state.bugun || new Date().toISOString().split('T')[0]; }

function barberName(id){
  const u = state.ustalar.find(x => x.id === id);
  return u ? u.ad : (id || '');
}

/** "Furkan Can Toprak" -> "FT" */
function barberInitials(ad){
  const p = String(ad || '').trim().split(/\s+/);
  if(p.length === 0) return '?';
  if(p.length === 1) return p[0].slice(0,2).toLocaleUpperCase('tr');
  return (p[0][0] + p[p.length-1][0]).toLocaleUpperCase('tr');
}

function showToast(msg, type='', dur=3000){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = type ? `show ${type}` : 'show';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = type; }, dur);
}

/** Randevunun zamanı geçti mi? Geçmişse yönetici listesinden düşer,
 *  ama kaydı durur; parası Hesap Defteri'nde kalır. */
function randevuGecti(r){
  if(!r || !r.tarih) return false;
  const bugun = today();
  if(r.tarih < bugun) return true;
  if(r.tarih > bugun) return false;
  const s = new Date();
  const [hh, mm] = String(r.saat || '00:00').split(':').map(Number);
  return (hh*60 + mm) <= (s.getHours()*60 + s.getMinutes());
}

// =====================================================================
//  SUNUCU İSTEMCİSİ
//  Tek giriş noktası. Yönetici jetonu varsa başlığa eklenir.
// =====================================================================
const API = {
  async istek(yol, secenekler = {}){
    const basliklar = { 'Content-Type': 'application/json' };
    if(state.jeton) basliklar['Authorization'] = `Bearer ${state.jeton}`;

    let yanit;
    try {
      yanit = await fetch(API_TEMEL + yol, { ...secenekler, headers: basliklar });
    } catch (e) {
      // Ağ hatası: sunucu kapalı, internet yok ya da CORS engeli.
      throw new Error('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.');
    }

    let veri = null;
    try { veri = await yanit.json(); } catch { /* gövdesiz cevap olabilir */ }

    if(yanit.status === 401){
      // Oturum düştü: sessizce çıkart.
      state.jeton = null;
      state.isAdmin = false;
      state.rol = null;
      oturumuSil();
    }
    if(!yanit.ok){
      throw new Error((veri && veri.hata) || 'İşlem tamamlanamadı.');
    }
    return veri;
  },
  get(yol){ return this.istek(yol); },
  post(yol, govde){ return this.istek(yol, { method:'POST', body: JSON.stringify(govde || {}) }); },
  put(yol, govde){ return this.istek(yol, { method:'PUT', body: JSON.stringify(govde || {}) }); },
  sil(yol){ return this.istek(yol, { method:'DELETE' }); }
};

// =====================================================================
//  ARAYÜZ — MÜŞTERİ AKIŞI
//  Sıra: TARİH -> USTA -> SAAT -> BİLGİLER
//  Müsaitlik usta bazındadır: aynı saat bir ustada dolu, diğerinde boş olabilir.
// =====================================================================
const UI = {

  initCalendar(){
    const yerel = (window.flatpickr && flatpickr.l10ns && flatpickr.l10ns.tr) ? { locale:'tr' } : {};
    state.flatpickr = flatpickr('#calendar', {
      inline: true, minDate: 'today', ...yerel,
      onDayCreate(dObj, dStr, fp, dayElem){
        const g = fp.formatDate(dayElem.dateObj, 'Y-m-d');
        if(state.kapaliGunler.includes(g)) dayElem.classList.add('blocked-day');
        if(state.isAdmin && state.randevular.some(r => r.tarih === g && !r.iptal_mi)) dayElem.classList.add('has-appt');
      },
      onChange(secilenler, dateStr, instance){
        if(!secilenler.length) return;
        const g = instance.formatDate(secilenler[0], 'Y-m-d');
        if(state.kapaliGunler.includes(g)){
          showToast('Bu gün randevulara kapalıdır.', 'error');
          instance.clear();
          return;
        }
        state.selectedDate = g;
        state.selectedBarber = null;
        state.selectedTime = null;
        document.getElementById('bookingFormSection').classList.remove('visible');
        document.getElementById('timeSlotSection').classList.remove('visible');
        UI.gunuYukle(g);
      }
    });
  },

  redrawCalendar(){ if(state.flatpickr) state.flatpickr.redraw(); },

  /** Seçilen günün doluluk bilgisini sunucudan çeker, sonra usta listesini açar.
   *  Cevapta müşteri adı ya da telefonu YOKTUR, sadece dolu saatler gelir. */
  async gunuYukle(tarih){
    try {
      state.gunDurumu = await API.get('/api/musait?tarih=' + encodeURIComponent(tarih));
    } catch (e) {
      showToast(e.message, 'error');
      state.gunDurumu = { kapali:false, dolu:{}, gecmis:[] };
    }
    if(state.gunDurumu.kapali){
      showToast('Bu gün randevulara kapalıdır.', 'error');
      if(state.flatpickr) state.flatpickr.clear();
      return;
    }
    this.showBarbers();
    setTimeout(() => document.getElementById('barberSection')
      .scrollIntoView({ behavior:'smooth', block:'start' }), 80);
  },

  // ADIM 2 — USTA SEÇİMİ
  showBarbers(){
    document.getElementById('barberSection').classList.add('visible');
    document.getElementById('selectedDateLabelBarber').textContent = formatDateTR(state.selectedDate);
    const grid = document.getElementById('barberGrid');
    grid.innerHTML = '';
    state.ustalar.forEach(u => {
      const div = document.createElement('div');
      div.className = 'barber-item' + (state.selectedBarber === u.id ? ' barber-selected' : '');
      div.innerHTML = '<span class="barber-avatar">' + escHtml(barberInitials(u.ad)) + '</span>' +
                      '<span class="barber-body"><span class="barber-name">' + escHtml(u.ad) + '</span>' +
                      '<span class="barber-role">Usta</span></span>';
      div.onclick = () => UI.selectBarber(u.id, div);
      grid.appendChild(div);
    });
  },

  selectBarber(id, el){
    const saatlerAcik = document.getElementById('timeSlotSection').classList.contains('visible');
    if(state.selectedBarber === id && saatlerAcik) return;
    document.querySelectorAll('.barber-item').forEach(x => x.classList.remove('barber-selected'));
    el.classList.add('barber-selected');
    state.selectedBarber = id;
    state.selectedTime = null;
    document.getElementById('bookingFormSection').classList.remove('visible');
    UI.showTimeSlots();
    setTimeout(() => document.getElementById('timeSlotSection')
      .scrollIntoView({ behavior:'smooth', block:'start' }), 80);
  },

  // ADIM 3 — SAAT SEÇİMİ
  showTimeSlots(){
    if(!state.selectedDate || !state.selectedBarber) return;
    document.getElementById('timeSlotSection').classList.add('visible');
    document.getElementById('selectedDateLabel').textContent = formatDateTR(state.selectedDate);
    document.getElementById('selectedBarberLabel').textContent = barberName(state.selectedBarber);

    const grid = document.getElementById('timeGrid');
    grid.innerHTML = '';
    // Yalnızca SEÇİLİ USTANIN o saatteki randevusu dolu sayılır.
    const doluSaatler = state.gunDurumu.dolu[state.selectedBarber] || [];
    const gecmisSaatler = state.gunDurumu.gecmis || [];

    state.saatler.forEach(t => {
      const dolu = doluSaatler.includes(t);
      const gecmis = gecmisSaatler.includes(t);
      const div = document.createElement('div');
      div.className = 'time-slot' + (dolu ? ' slot-booked' : '') +
                      ((!dolu && gecmis) ? ' slot-blocked' : '');
      if(dolu){
        div.innerHTML = '<span class="slot-time">' + t + '</span><span class="slot-label">Dolu</span>';
      } else if(gecmis){
        div.innerHTML = '<span class="slot-time">' + t + '</span><span class="slot-label">Geçti</span>';
      } else {
        div.innerHTML = '<span class="slot-time">' + t + '</span>';
        if(state.selectedTime === t) div.classList.add('slot-selected');
        div.onclick = () => UI.selectTime(t, div);
      }
      grid.appendChild(div);
    });
  },

  selectTime(t, el){
    if(state.selectedTime === t && state.formReady) return;
    document.querySelectorAll('.time-slot').forEach(s => s.classList.remove('slot-selected'));
    el.classList.add('slot-selected');
    state.selectedTime = t;
    if(!document.getElementById('bookingFormSection').classList.contains('visible')){
      UI.showBookingForm();
      setTimeout(() => document.getElementById('bookingFormSection')
        .scrollIntoView({ behavior:'smooth', block:'start' }), 80);
    }
  },

  // ADIM 4 — BİLGİ FORMU
  showBookingForm(){
    document.getElementById('bookingFormSection').classList.add('visible');
    document.getElementById('bookingSummary').textContent =
      '📅 ' + formatDateTR(state.selectedDate) + '  ·  ⏰ ' + state.selectedTime +
      '  ·  💈 ' + barberName(state.selectedBarber);

    // Hizmet listesi ve alanlar YALNIZCA ilk açılışta kurulur; kullanıcı tarih
    // ya da usta değiştirince yazdıkları silinmez, sadece özet güncellenir.
    if(state.formReady) return;
    state.formReady = true;
    state.selectedServices = [];

    const sg = document.getElementById('serviceGrid');
    sg.innerHTML = '';
    state.hizmetler.forEach(h => {
      const div = document.createElement('div');
      div.className = 'service-item';
      div.innerHTML = '<span class="service-check"></span><span>' + escHtml(h) + '</span>';
      div.dataset.svc = h;
      div.onclick = () => UI.hizmetSec(h);
      sg.appendChild(div);
    });
    UI.hizmetleriTazele();
    document.getElementById('guestName').value = '';
    document.getElementById('guestPhone').value = '';
  },

  /** Bu hizmet şu an seçili olanlardan biriyle çakışıyor mu?
   *  Çakışıyorsa engelleyen hizmetin adını döner.
   *  Sunucu aynı kontrolü tekrar yapar; tarayıcıya güvenilmez. */
  hizmetEngeli(h){
    for(const grup of (state.hizmetCakisma || [])){
      if(grup.indexOf(h) < 0) continue;
      for(const digeri of grup){
        if(digeri !== h && state.selectedServices.indexOf(digeri) >= 0) return digeri;
      }
    }
    return null;
  },

  hizmetSec(h){
    const i = state.selectedServices.indexOf(h);
    if(i >= 0){
      state.selectedServices.splice(i, 1);
    } else {
      const engel = this.hizmetEngeli(h);
      if(engel){ showToast('"' + engel + '" seçiliyken "' + h + '" seçilemez.', 'error'); return; }
      state.selectedServices.push(h);
    }
    this.hizmetleriTazele();
  },

  hizmetleriTazele(){
    document.querySelectorAll('#serviceGrid .service-item').forEach(div => {
      const h = div.dataset.svc;
      const secili = state.selectedServices.indexOf(h) >= 0;
      div.classList.toggle('selected', secili);
      div.classList.toggle('service-kilitli', !secili && !!this.hizmetEngeli(h));
    });
  },

  resetSlotSelection(){
    state.selectedTime = null;
    state.formReady = false;
    document.querySelectorAll('.time-slot').forEach(s => s.classList.remove('slot-selected'));
    document.getElementById('bookingFormSection').classList.remove('visible');
  },

  showSuccess(r){
    document.getElementById('calendarCard').style.display = 'none';
    document.getElementById('barberSection').classList.remove('visible');
    document.getElementById('timeSlotSection').classList.remove('visible');
    document.getElementById('bookingFormSection').classList.remove('visible');

    const satir = (ikon, etiket, deger) =>
      '<div class="success-row"><span class="success-row-icon">' + ikon + '</span>' +
      '<div class="success-row-body"><span class="success-row-label">' + etiket + '</span>' +
      '<span class="success-row-val">' + escHtml(deger) + '</span></div></div>';

    document.getElementById('successDetails').innerHTML =
      satir('👤', 'Ad Soyad', r.ad) +
      satir('📅', 'Tarih', formatDateTR(r.tarih)) +
      satir('⏰', 'Saat', r.saat) +
      satir('💈', 'Usta', r.ustaAdi) +
      satir('✂️', 'Hizmet', r.hizmetler);

    const sc = document.getElementById('successCard');
    sc.classList.add('visible');
    setTimeout(() => sc.scrollIntoView({ behavior:'smooth', block:'start' }), 50);
  },

  resetAll(){
    state.formReady = false;
    document.getElementById('successCard').classList.remove('visible');
    document.getElementById('calendarCard').style.display = '';
    document.getElementById('barberSection').classList.remove('visible');
    document.getElementById('timeSlotSection').classList.remove('visible');
    document.getElementById('bookingFormSection').classList.remove('visible');
    state.selectedDate = null;
    state.selectedBarber = null;
    state.selectedTime = null;
    state.selectedServices = [];
    document.getElementById('guestName').value = '';
    document.getElementById('guestPhone').value = '';
    if(state.flatpickr) state.flatpickr.clear();
    window.scrollTo({ top:0, behavior:'smooth' });
  },

  // ===== MENÜ VE TANITIM SAYFALARI =====
  openNavMenu(){ document.getElementById('navOverlay').classList.add('show'); },
  closeNavMenu(){ document.getElementById('navOverlay').classList.remove('show'); },
  openAboutPage(){ this.closeNavMenu(); document.getElementById('aboutOverlay').classList.add('show'); },
  closeAboutPage(){ document.getElementById('aboutOverlay').classList.remove('show'); },
  openServicesPage(){ this.closeNavMenu(); document.getElementById('servicesOverlay').classList.add('show'); },
  closeServicesPage(){ document.getElementById('servicesOverlay').classList.remove('show'); },

  // ===== YÖNETİCİ PANELİ =====
  handleAdminButton(){
    if(state.isAdmin) this.openAdminPanel();
    else this.showAdminLogin();
  },
  showAdminLogin(){
    document.getElementById('adminLoginOverlay').classList.remove('hidden');
    setTimeout(() => { const p = document.getElementById('adminPass'); if(p) p.focus(); }, 60);
  },
  closeAdminLogin(){
    document.getElementById('adminLoginOverlay').classList.add('hidden');
    const p = document.getElementById('adminPass'); if(p) p.value = '';
  },
  openAdminPanel(){
    // KİLİT: jetonu olmayan hiçbir yönetim ekranı göremez.
    if(!state.isAdmin){ this.showAdminLogin(); return; }
    document.getElementById('adminLoginOverlay').classList.add('hidden');
    document.getElementById('adminPanelOverlay').classList.remove('hidden');
    this.yetkiyeGoreAyarla();
    this.showAdminView('home');
  },

  /** Rolü usta olan kişide Hesap Defteri, Müşteri Analizi ve gün yönetimi
   *  gizlenir. Sunucu da bu uçları zaten 403 ile reddediyor; burası sadece
   *  görünmeyeni tıklanamaz da yapıyor. */
  yetkiyeGoreAyarla(){
    const yonetici = yoneticiMi();
    for(const id of ['menuHesap', 'menuAnaliz', 'gunYonetimBaslik', 'gunYonetimKutu']){
      const el = document.getElementById(id);
      if(el) el.style.display = yonetici ? '' : 'none';
    }
    const baslik = document.querySelector('#adminHome .admin-fs-title');
    if(baslik){
      baslik.textContent = yonetici ? 'Yönetim Paneli' : 'Randevularım';
    }
    const altYazi = document.querySelector('#adminRandevular .admin-fs-title');
    if(altYazi){
      altYazi.textContent = yonetici ? 'Randevular' : 'Randevularım';
    }
  },
  closeAdminPanel(){ document.getElementById('adminPanelOverlay').classList.add('hidden'); },

  showAdminView(gorunum){
    if(!state.isAdmin){ this.showAdminLogin(); return; }
    // Usta rolü hesap defterini ve müşteri analizini açamaz
    if(!yoneticiMi() && (gorunum === 'hesap' || gorunum === 'analiz')){
      showToast('Bu bölüme yetkiniz yok.', 'error');
      gorunum = 'home';
    }
    ['Home','Randevular','Hesap','Analiz'].forEach(v => {
      const el = document.getElementById('admin' + v);
      if(el) el.style.display = 'none';
    });
    const harita = { home:'Home', randevular:'Randevular', hesap:'Hesap', analiz:'Analiz' };
    const el = document.getElementById('admin' + (harita[gorunum] || 'Home'));
    if(el) el.style.display = '';
    const ov = document.getElementById('adminPanelOverlay'); if(ov) ov.scrollTop = 0;

    if(gorunum === 'home'){ this.ozetiYukle(); Bildirim.durumuGoster(); }
    else if(gorunum === 'randevular') this.randevulariYukleVeCiz();
    else if(gorunum === 'hesap') Finance.render();
    else if(gorunum === 'analiz'){ this.analizSecim = null; this.randevulariYukleVeCiz(true); }
  },

  /** Panelin üstündeki kısa özet: toplam kayıt, yaklaşan, iptalli.
   *  Tek hafif sorgu, sunucuda sayılıyor; bütün liste indirilmiyor. */
  async ozetiYukle(){
    const el = document.getElementById('adminOzet');
    if(!el) return;
    try {
      const o = await API.get('/api/ozet');
      const parcalar = [o.toplam + ' kayıt'];
      if(o.yaklasan > 0) parcalar.push(o.yaklasan + ' yaklaşan');
      if(o.iptalli > 0) parcalar.push(o.iptalli + ' iptalli');
      if(o.ilkTarih && o.sonTarih){
        parcalar.push(formatDateTR(o.ilkTarih) + ' - ' + formatDateTR(o.sonTarih));
      }
      el.textContent = parcalar.join('  ·  ');
    } catch (e) {
      el.textContent = '';
    }
  },

  /** Randevuları sunucudan çeker. Yönetici uçları müşteri bilgilerini de döner. */
  async randevulariYukleVeCiz(analizIcin){
    try {
      // İptalliler de gelsin: "İptal Edilenler" sekmesi bunları gösteriyor
      const veri = await API.get('/api/randevular?iptalli=1');
      state.randevular = veri.randevular || [];
      this.redrawCalendar();
    } catch (e) {
      showToast(e.message, 'error');
      if(!state.isAdmin){ this.closeAdminPanel(); this.showAdminLogin(); return; }
    }
    if(analizIcin) this.renderAnaliz();
    else this.renderAdminPanel();
  },

  filterAppts(tur, btn){
    state.adminFilter = tur;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    this.renderAdminPanel();
  },

  renderAdminPanel(){
    const list = document.getElementById('adminApptList');
    const bugun = today();
    const iptalliSekme = state.adminFilter === 'cancelled';

    let liste;
    if(iptalliSekme){
      // İptal edilenler: tarihi geçmiş olsa bile gösterilir, çünkü
      // geri alma ihtimali var ve kayıt hesap defterini etkiliyor.
      liste = state.randevular.filter(r => r.iptal_mi)
        .sort((a, b) => a.tarih !== b.tarih ? (a.tarih > b.tarih ? -1 : 1) : (a.saat > b.saat ? -1 : 1));
    } else {
      // Zamanı geçen randevular listeden düşer; kaydı ve parası durur.
      liste = state.randevular.filter(r => !r.iptal_mi && !randevuGecti(r))
        .sort((a, b) => a.tarih !== b.tarih ? (a.tarih < b.tarih ? -1 : 1) : (a.saat < b.saat ? -1 : 1));
      if(state.adminFilter === 'today') liste = liste.filter(r => r.tarih === bugun);
      if(state.adminFilter === 'upcoming') liste = liste.filter(r => r.tarih >= bugun);
    }

    const aktif = state.randevular.filter(r => !r.iptal_mi && !randevuGecti(r)).length;
    const iptalliAdet = state.randevular.filter(r => r.iptal_mi).length;
    const alt = document.getElementById('adminSubtitle');
    if(alt){
      alt.textContent = iptalliSekme
        ? iptalliAdet + ' iptal edilmiş randevu'
        : aktif + ' aktif randevu';
    }

    const bosMesaj = iptalliSekme
      ? 'İptal edilmiş randevu bulunmuyor.'
      : 'Bu filtrede randevu bulunmuyor.';

    list.innerHTML = liste.length === 0
      ? '<div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg><p>' + bosMesaj + '</p></div>'
      : liste.map(r => {
          const gecmis = r.tarih < bugun;
          const rozet = r.iptal_mi
            ? '<span class="badge badge-accent">İptal</span>'
            : '<span class="badge ' + (gecmis ? 'badge-accent' : 'badge-success') + '">' +
              (gecmis ? 'Geçmiş' : 'Aktif') + '</span>';
          const dugme = r.iptal_mi
            ? '<button class="btn btn-secondary btn-sm" onclick="Logic.restoreAppointment(&quot;' + escHtml(r.id) + '&quot;)">Geri Al</button>'
            : '<button class="btn btn-danger btn-sm" onclick="Logic.cancelAppointment(&quot;' + escHtml(r.id) + '&quot;)">İptal Et</button>';
          return '<div class="appt-item"><div class="appt-meta"><div><div class="appt-name">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>' +
            escHtml(r.ad) + '</div><div class="appt-details">📅 ' + formatDateTR(r.tarih) +
            ' — ⏰ ' + escHtml(r.saat) + '<br>💈 ' + escHtml(r.ustaAdi || barberName(r.usta)) +
            '<br>✂️ ' + escHtml(r.hizmetler || '—') + '<br>📞 ' + escHtml(r.telefon) +
            '</div></div>' + rozet + '</div>' + dugme + '</div>';
        }).join('');

    const bd = document.getElementById('blockedDaysList');
    if(bd){
      bd.innerHTML = state.kapaliGunler.length
        ? '🔒 Kapalı günler: ' + state.kapaliGunler.map(d => formatDateTR(d)).join(', ')
        : 'Kapalı gün bulunmuyor.';
    }
  },

  // ===== MÜŞTERİ ANALİZİ =====
  // İki ekran var:
  //   analizSecim === null      -> yıl kartı + 12 ay düğmesi
  //   analizSecim = 0..11 | 'yil' -> müşteri sıralaması (çoktan aza)
  analizSecim: null,
  AYLAR: ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
          'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'],

  analizAc(sec){
    this.analizSecim = sec;
    this.renderAnaliz();
    const ov = document.getElementById('adminPanelOverlay'); if(ov) ov.scrollTop = 0;
  },
  analizGeri(){
    if(this.analizSecim !== null){
      this.analizSecim = null;
      this.renderAnaliz();
      const ov = document.getElementById('adminPanelOverlay'); if(ov) ov.scrollTop = 0;
    } else {
      this.showAdminView('home');
    }
  },
  renderAnaliz(){
    if(this.analizSecim === null) this.analizAylariCiz();
    else this.analizDetayCiz();
  },

  /** Müşterileri randevu sayısına göre çoktan aza sıralar.
   *  Aynı kişi telefonundan tanınır, telefon yoksa isminden. */
  analizSirala(kabul){
    const harita = {};
    state.randevular.forEach(r => {
      if(!r.tarih) return;
      const [y, a] = r.tarih.split('-').map(Number);
      if(!kabul(y, a - 1)) return;
      const anahtar = String(r.telefon || r.ad || '?').trim();
      if(!harita[anahtar]){
        harita[anahtar] = { ad: r.ad || '-', telefon: r.telefon || '', adet: 0, ustalar: {} };
      }
      const k = harita[anahtar];
      k.adet++;
      // Tıraşı kimin yaptığı: müşteri iki ustaya da gitmiş olabilir,
      // o yüzden usta usta sayılıyor.
      const ustaAdi = r.ustaAdi || barberName(r.usta) || 'Bilinmiyor';
      k.ustalar[ustaAdi] = (k.ustalar[ustaAdi] || 0) + 1;
    });
    return Object.values(harita)
      .sort((a, b) => b.adet - a.adet || a.ad.localeCompare(b.ad, 'tr'));
  },

  /** "Furkan 3 · Serhat 2" biçiminde kısa döküm. Tek usta varsa sadece adı. */
  ustaDokumu(ustalar){
    const girisler = Object.entries(ustalar || {}).sort((a, b) => b[1] - a[1]);
    if(girisler.length === 0) return '';
    if(girisler.length === 1) return girisler[0][0].split(' ')[0];
    return girisler.map(([ad, n]) => ad.split(' ')[0] + ' ' + n).join(' · ');
  },

  // EKRAN 1 — yıl kartı ve 12 ay
  analizAylariCiz(){
    const yil = Number(today().slice(0, 4));
    const buAy = Number(today().slice(5, 7)) - 1;
    const ayl = document.getElementById('analizAylar');
    const det = document.getElementById('analizDetay');
    if(!ayl || !det) return;
    ayl.style.display = ''; det.style.display = 'none';
    document.getElementById('analizBaslik').textContent = 'Müşteri Analizi';
    document.getElementById('analizAltBaslik').textContent = 'Bir ay seçin';

    const sayi = new Array(12).fill(0);
    let yilToplam = 0;
    state.randevular.forEach(r => {
      if(!r.tarih) return;
      const [y, a] = r.tarih.split('-').map(Number);
      if(y === yil && a >= 1 && a <= 12){ sayi[a - 1]++; yilToplam++; }
    });

    document.getElementById('analizYilNo').textContent = yil;
    document.getElementById('analizYilAlt').textContent = 'Bu yılın tamamı · ' + yilToplam + ' randevu';
    document.getElementById('analizAyGrid').innerHTML = this.AYLAR.map((ad, i) => {
      const gelecek = i > buAy;
      const bu = i === buAy;
      const cls = 'analiz-ay-btn' + (bu ? ' ay-bu' : '') + (gelecek ? ' ay-gelecek' : '');
      const alt = (gelecek && sayi[i] === 0) ? 'Henüz gelmedi' : (sayi[i] + ' randevu');
      return '<div class="' + cls + '" onclick="UI.analizAc(' + i + ')">' +
             '<div class="analiz-ay-ad">' + ad + '</div>' +
             '<div class="analiz-ay-sayi">' + alt + '</div>' +
             (bu ? '<div class="analiz-ay-etiket">Bu ay</div>' : '') + '</div>';
    }).join('');
  },

  // EKRAN 2 — seçilen ayın ya da tüm yılın müşteri sıralaması
  analizDetayCiz(){
    const yil = Number(today().slice(0, 4));
    const sec = this.analizSecim;
    const tumYil = (sec === 'yil');
    const ayl = document.getElementById('analizAylar');
    const det = document.getElementById('analizDetay');
    if(!ayl || !det) return;
    ayl.style.display = 'none'; det.style.display = '';
    document.getElementById('analizBaslik').textContent =
      tumYil ? String(yil) : (this.AYLAR[sec] + ' ' + yil);

    const dizi = this.analizSirala((y, ai) => y === yil && (tumYil || ai === sec));
    const toplam = dizi.reduce((t, c) => t + c.adet, 0);
    document.getElementById('analizAltBaslik').textContent =
      dizi.length + ' müşteri · ' + toplam + ' randevu';

    const kutu = document.getElementById('analizList');
    if(!kutu) return;
    kutu.innerHTML = dizi.length === 0
      ? '<div class="empty-state"><p>' + (tumYil ? 'Bu yıl' : 'Bu ay') + ' henüz randevu yok.</p></div>'
      : dizi.map((c, i) =>
          '<div class="analiz-item"><div class="analiz-rank ' + (i < 3 ? 'top' : '') + '">' + (i + 1) + '</div>' +
          '<div class="analiz-body"><div class="analiz-name">' + escHtml(c.ad) + '</div>' +
          '<div class="analiz-phone">' + escHtml(c.telefon) +
          '<br>💈 ' + escHtml(this.ustaDokumu(c.ustalar)) + '</div></div>' +
          '<div class="analiz-count">' + c.adet + ' randevu</div></div>'
        ).join('');
  }
};

// =====================================================================
//  İŞ MANTIĞI
// =====================================================================
const Logic = {

  async adminLogin(){
    const kullanici = document.getElementById('adminUser').value.trim();
    const sifre = document.getElementById('adminPass').value;
    if(!kullanici){ showToast('Kullanıcı adınızı girin.', 'error'); return; }
    if(!sifre){ showToast('Şifrenizi girin.', 'error'); return; }

    try {
      const veri = await API.post('/api/giris', { kullanici, sifre });
      state.jeton = veri.jeton;
      state.isAdmin = true;
      state.kullanici = veri.kullanici;
      state.kullaniciAdi = veri.ad;
      state.rol = veri.rol;
      state.ustaId = veri.ustaId || null;
      state.vapidAnahtari = veri.vapidAnahtari || null;

      // Cihazda kalıcı. Tarayıcı kapansa bile şifre tekrar sorulmaz,
      // yalnızca Çıkış Yap ile düşer.
      oturumuKaydet({
        jeton: veri.jeton, kullanici: veri.kullanici, ad: veri.ad,
        rol: veri.rol, ustaId: veri.ustaId || null,
        vapidAnahtari: veri.vapidAnahtari || null
      });

      document.getElementById('adminPass').value = '';
      showToast(veri.ad + ', hoş geldiniz', 'success');
      UI.openAdminPanel();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async adminLogout(){
    // Çıkarken bu cihazın bildirim aboneliği de silinsin, yoksa
    // başkası giriş yaptığında eski kişiye bildirim gitmeye devam eder.
    try { await Bildirim.kapat(); } catch {}
    state.jeton = null;
    state.isAdmin = false;
    state.kullanici = null;
    state.kullaniciAdi = null;
    state.rol = null;
    state.ustaId = null;
    state.randevular = [];
    oturumuSil();
    UI.closeAdminPanel();
    UI.redrawCalendar();
    showToast('Çıkış yapıldı', 'success');
  },

  /** Randevu onayı. Sunucu bütün kontrolleri tekrar yapar;
   *  buradakiler sadece kullanıcıya hızlı geri bildirim içindir. */
  async confirmAppointment(){
    if(!state.selectedDate){ showToast('Lütfen bir tarih seçin.', 'error'); return; }
    if(!state.selectedBarber){ showToast('Lütfen bir usta seçin.', 'error'); return; }
    if(!state.selectedTime){ showToast('Lütfen bir saat seçin.', 'error'); return; }
    if(state.selectedServices.length === 0){ showToast('En az bir hizmet seçin.', 'error'); return; }

    const ad = document.getElementById('guestName').value.trim();
    const telefon = document.getElementById('guestPhone').value.trim();
    if(ad.length < 2){ showToast('Lütfen adınızı yazın.', 'error'); return; }
    if(telefon.replace(/\D/g, '').length < 10){ showToast('Telefon numaranızı kontrol edin.', 'error'); return; }

    const dugme = document.querySelector('#bookingFormSection .btn-primary');
    const eskiYazi = dugme ? dugme.textContent : '';
    if(dugme){ dugme.disabled = true; dugme.textContent = 'Gönderiliyor…'; }

    try {
      const veri = await API.post('/api/randevu', {
        tarih: state.selectedDate,
        saat: state.selectedTime,
        usta: state.selectedBarber,
        ad, telefon,
        hizmetler: state.selectedServices,
        turnstile: Turnstile.jetonAl()
      });
      state.selectedDate = null;
      state.selectedBarber = null;
      state.selectedTime = null;
      state.selectedServices = [];
      state.formReady = false;
      UI.showSuccess(veri.randevu);
    } catch (e) {
      showToast(e.message, 'error');
      // Slot kapıldıysa güncel doluluğu çekip saatleri yeniden çiz.
      if(state.selectedDate){
        await UI.gunuYukle(state.selectedDate);
        UI.showTimeSlots();
      }
    } finally {
      if(dugme){ dugme.disabled = false; dugme.textContent = eskiYazi; }
      Turnstile.sifirla();
    }
  },

  async cancelAppointment(id){
    if(!confirm('Bu randevuyu iptal etmek istediğine emin misin? Tutar hesaptan düşülecek.')) return;
    try {
      await API.sil('/api/randevu/' + encodeURIComponent(id));
      showToast('Randevu iptal edildi.', 'success');
      await UI.randevulariYukleVeCiz();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  /** İptal edilmiş randevuyu geri alır.
   *  İptal edilince o saat boşa düştüğü için başkası almış olabilir;
   *  o durumda sunucu reddeder ve sebebini açıkça söyler. */
  async restoreAppointment(id){
    if(!confirm('Bu randevuyu geri almak istediğine emin misin? Tutar hesaba geri eklenecek.')) return;
    try {
      await API.post('/api/randevu/' + encodeURIComponent(id) + '/geri-al', {});
      showToast('Randevu geri alındı.', 'success');
      await UI.randevulariYukleVeCiz();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async blockDay(){
    const tarih = document.getElementById('adminBlockDate').value.trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(tarih)){ showToast('Tarihi YYYY-AA-GG biçiminde yazın.', 'error'); return; }
    try {
      await API.post('/api/kapali-gunler', { tarih });
      if(!state.kapaliGunler.includes(tarih)) state.kapaliGunler.push(tarih);
      state.kapaliGunler.sort();
      showToast('Gün kapatıldı.', 'success');
      UI.renderAdminPanel();
      UI.redrawCalendar();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async unblockDay(){
    const tarih = document.getElementById('adminBlockDate').value.trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(tarih)){ showToast('Tarihi YYYY-AA-GG biçiminde yazın.', 'error'); return; }
    try {
      await API.sil('/api/kapali-gunler/' + encodeURIComponent(tarih));
      state.kapaliGunler = state.kapaliGunler.filter(d => d !== tarih);
      showToast('Gün açıldı.', 'success');
      UI.renderAdminPanel();
      UI.redrawCalendar();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }
};

// =====================================================================
//  TURNSTILE (bot koruması)
//  Backend'de gizli anahtar tanımlıysa site anahtarı /api/baslangic ile gelir
//  ve doğrulama kutusu forma eklenir. Tanımlı değilse hiçbir şey olmaz.
// =====================================================================
const Turnstile = {
  widgetId: null,
  kur(){
    if(!state.turnstileAnahtari || window.turnstile) return;
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.onload = () => this.ciz();
    document.head.appendChild(s);
  },
  ciz(){
    const form = document.getElementById('bookingFormSection');
    if(!form || !window.turnstile) return;
    let kutu = document.getElementById('turnstileKutu');
    if(!kutu){
      kutu = document.createElement('div');
      kutu.id = 'turnstileKutu';
      kutu.style.margin = '10px 0';
      const satir = form.querySelector('.btn-row');
      form.insertBefore(kutu, satir);
    }
    try {
      this.widgetId = window.turnstile.render(kutu, { sitekey: state.turnstileAnahtari });
    } catch {}
  },
  jetonAl(){
    if(!window.turnstile || this.widgetId === null) return null;
    try { return window.turnstile.getResponse(this.widgetId); } catch { return null; }
  },
  sifirla(){
    if(!window.turnstile || this.widgetId === null) return;
    try { window.turnstile.reset(this.widgetId); } catch {}
  }
};

// =====================================================================
//  HESAP DEFTERİ
//  Bütün hesap SUNUCUDA yapılır. Fiyatlar ve giderler tarayıcıya
//  yalnızca yönetici girişi yapıldıktan sonra, hazır toplam olarak iner.
// =====================================================================
const Finance = {
  period: 'year',
  ay: new Date().getMonth(),
  chart: null,
  sonRapor: null,

  // HTML'deki düğmeler İngilizce anahtar kullanıyor, sunucu Türkçe bekliyor.
  SUNUCU_DONEMI: { day:'gun', week:'hafta', month:'ay', year:'yil' },

  fmt(n){ return '₺' + Math.round(Number(n) || 0).toLocaleString('tr-TR'); },

  aySec(m){ this.ay = m; this.render('month'); },

  async render(period, btn){
    if(period) this.period = period;

    const yilDugmesi = document.querySelector('#financePeriod .fp-btn[data-period="year"]');
    if(yilDugmesi) yilDugmesi.textContent = today().slice(0, 4);

    document.querySelectorAll('#financePeriod .fp-btn').forEach(b => b.classList.remove('active'));
    if(btn) btn.classList.add('active');
    else {
      const b = document.querySelector('#financePeriod .fp-btn[data-period="' + this.period + '"]');
      if(b) b.classList.add('active');
    }
    this.aySeridiCiz();

    let rapor;
    try {
      let yol = '/api/rapor?donem=' + this.SUNUCU_DONEMI[this.period];
      if(this.period === 'month') yol += '&ay=' + this.ay;
      rapor = await API.get(yol);
    } catch (e) {
      showToast(e.message, 'error');
      return;
    }
    this.sonRapor = rapor;

    const g = document.getElementById('finGelir'); if(g) g.textContent = this.fmt(rapor.gelir);
    const gd = document.getElementById('finGider'); if(gd) gd.textContent = this.fmt(rapor.gider);
    const k = document.getElementById('finKar');
    if(k) k.textContent = (rapor.net >= 0 ? '+' : '') + this.fmt(rapor.net);

    this.giderDokumuCiz(rapor);
    this.notuYaz();
    this.dokumCiz(rapor);
    this.draw(rapor.etiketler, rapor.seri.map(s => s.gelir - s.gider));
  },

  // "Ay" sekmesindeki 12 aylık şerit — geçmiş aylara bakabilmek için
  aySeridiCiz(){
    const el = document.getElementById('financeAySerit');
    if(!el) return;
    if(this.period !== 'month'){ el.style.display = 'none'; return; }
    el.style.display = '';
    const buAy = Number(today().slice(5, 7)) - 1;
    const kisa = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
    el.innerHTML = kisa.map((ad, i) => {
      const cls = 'fin-ay-btn' + (i === this.ay ? ' aktif' : '') + (i > buAy ? ' gelecek' : '');
      return '<div class="' + cls + '" onclick="Finance.aySec(' + i + ')">' + ad + '</div>';
    }).join('');
  },

  notuYaz(){
    const yil = today().slice(0, 4);
    const AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                   'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
    const notlar = {
      day: 'Bugün — saatlere göre net kâr',
      week: 'Bu hafta — günlere göre net kâr',
      month: AYLAR[this.ay] + ' ' + yil + ' — haftalara göre net kâr',
      year: yil + ' — aylara göre net kâr'
    };
    const n = document.getElementById('financeNote');
    if(n) n.textContent = notlar[this.period] || '';
  }
,

  /** Gider dökümü: sabit kalemler dönem oranıyla + usta primleri.
   *  Toplam, üstteki Gider kutusuyla birebir aynıdır. */
  giderDokumuCiz(rapor){
    const kutu = document.getElementById('financeGiderDokum');
    if(!kutu) return;

    const kalemler = rapor.giderKalemleri || {};
    const aylikToplam = Object.keys(kalemler)
      .reduce((t, k) => t + (Number(kalemler[k]) || 0), 0);
    // Dönem, kaç aylık sabit gidere denk geliyor
    const oran = aylikToplam > 0 ? (rapor.sabitGider / aylikToplam) : 0;

    const satir = (ad, tutar, cls) =>
      '<div class="fin-gd-row' + (cls || '') + '"><span class="fin-gd-ad">' + escHtml(ad) +
      '</span><span class="fin-gd-tutar">' + this.fmt(tutar) + '</span></div>';

    let html = Object.keys(kalemler)
      .map(k => satir(k, (Number(kalemler[k]) || 0) * oran)).join('');

    (rapor.primDokumu || []).forEach(p => {
      if(p.tutar > 0){
        html += satir('Usta Primi (' + p.ustaAdi + ' %' + Math.round(p.oran * 100) + ')', p.tutar);
      }
    });

    html += satir('TOPLAM GİDER', rapor.gider, ' fin-gd-toplam');
    html += '<p class="fin-gd-not">Sabit giderler aylık ' + this.fmt(aylikToplam) +
            ' olup ayın pazar hariç gün sayısına bölünür. Bu dönemde ' + (rapor.isGunu || 0) +
            ' iş günü sayıldı. Pazarlar, henüz gelmemiş günler ve dükkânın açılışından (' +
            formatDateTR(rapor.dukkanAcilis) + ') önceki günler hesaba katılmaz.</p>';
    kutu.innerHTML = html;
  },

  /** Bu dönemde sayılan randevuların tek tek listesi.
   *  Satırda sadece GELİR yazar; prim ve sabit gider üstteki kutuda toplu görünür. */
  dokumCiz(rapor){
    const kutu = document.getElementById('financeBreakdown');
    if(!kutu) return;
    const liste = rapor.dokum || [];
    if(liste.length === 0){
      kutu.innerHTML = '<div class="fin-bd-empty">Bu dönemde sayılan randevu yok.</div>';
      return;
    }
    kutu.innerHTML = liste.map(r =>
      '<div class="fin-bd-row"><div class="fin-bd-left">' + escHtml(r.ad || '-') +
      '<small>' + formatDateTR(r.tarih) + ' · ' + escHtml(r.saat || '') + ' · ' +
      escHtml(r.ustaAdi || '') + '<br>' + escHtml(r.hizmetler || '-') + '</small></div>' +
      '<div class="fin-bd-amt">' + this.fmt(r.gelir) + '</div></div>'
    ).join('');
  },

  draw(etiketler, karDizisi){
    const ctx = document.getElementById('financeChart');
    if(!ctx || typeof Chart === 'undefined') return;
    if(this.chart) this.chart.destroy();
    const enYuksek = Math.max(0, ...karDizisi);
    this.chart = new Chart(ctx, {
      type: 'line',
      data: { labels: etiketler, datasets: [{
        label: 'Net Kâr', data: karDizisi,
        borderColor: '#2D6A4F', backgroundColor: 'rgba(45,106,79,0.12)',
        fill: true, cubicInterpolationMode: 'monotone', tension: 0.4,
        pointRadius: 2, pointBackgroundColor: '#2D6A4F', borderWidth: 2.5
      }]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => '₺' + Math.round(c.parsed.y).toLocaleString('tr-TR') } }
        },
        scales: {
          x: { grid: { display: false },
               ticks: { color:'#A8A299', font:{size:10}, maxRotation:0, autoSkip:true, maxTicksLimit:8 } },
          y: { grid: { color:'rgba(26,24,20,0.06)' },
               ticks: { color:'#A8A299', font:{size:10}, precision:0,
                        callback: (v) => '₺' + Number(v).toLocaleString('tr-TR') },
               beginAtZero: true, suggestedMax: enYuksek > 0 ? undefined : 20000 }
        }
      }
    });
  }
};

// =====================================================================
//  BİLDİRİMLER (tarayıcının kendi bildirim altyapısı)
//
//  ntfy'nin yerini aldı. Abone olunacak bir kanal yok; bildirim doğrudan
//  bu cihaza geliyor ve yalnızca bu cihaz açabiliyor.
//
//  Abonelik GİRİŞ YAPMIŞ kişiye bağlanır. Siteyi açan bir müşteri bildirim
//  izni verse bile sunucuya kayıt olamaz, çünkü jetonu yoktur.
// =====================================================================
const Bildirim = {

  destekVarMi(){
    return 'serviceWorker' in navigator &&
           'PushManager' in window &&
           'Notification' in window;
  },

  /** iPhone'da bildirim yalnızca ana ekrana eklenmiş sitede çalışıyor. */
  iphoneAnaEkranGerekli(){
    const iphone = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const anaEkranda = window.navigator.standalone === true ||
                       window.matchMedia('(display-mode: standalone)').matches;
    return iphone && !anaEkranda;
  },

  b64ToBayt(b64url){
    const duz = (b64url + '='.repeat((4 - b64url.length % 4) % 4))
      .replace(/-/g, '+').replace(/_/g, '/');
    const ham = atob(duz);
    const cikti = new Uint8Array(ham.length);
    for(let i = 0; i < ham.length; i++) cikti[i] = ham.charCodeAt(i);
    return cikti;
  },

  baytaB64(tampon){
    return btoa(String.fromCharCode(...new Uint8Array(tampon)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },

  async kayit(){
    return navigator.serviceWorker.register('sw.js');
  },

  async mevcutAbonelik(){
    if(!this.destekVarMi()) return null;
    try {
      const k = await navigator.serviceWorker.getRegistration();
      if(!k) return null;
      return k.pushManager.getSubscription();
    } catch { return null; }
  },

  /** Paneldeki bildirim kutusunu günceller. */
  async durumuGoster(){
    const yazi = document.getElementById('bildirimDurumu');
    const dugme = document.getElementById('bildirimDugmesi');
    if(!yazi || !dugme) return;

    if(!this.destekVarMi()){
      yazi.textContent = 'Bu tarayıcı bildirimi desteklemiyor.';
      dugme.style.display = 'none';
      return;
    }
    if(this.iphoneAnaEkranGerekli()){
      yazi.textContent = "iPhone'da bildirim için önce siteyi ana ekrana ekleyin: " +
                         'alttaki paylaş düğmesi, sonra "Ana Ekrana Ekle". ' +
                         'Sonra o kısayoldan açıp buraya dönün.';
      dugme.style.display = 'none';
      return;
    }
    if(Notification.permission === 'denied'){
      yazi.textContent = 'Bildirim izni bu cihazda reddedilmiş. ' +
                         'Tarayıcı ayarlarından site iznini açmanız gerekiyor.';
      dugme.style.display = 'none';
      return;
    }

    const abonelik = await this.mevcutAbonelik();
    if(abonelik){
      yazi.textContent = 'Bu cihazda açık. Randevu gelince bildirim düşecek.';
      dugme.textContent = 'Bu Cihazda Kapat';
      dugme.style.display = '';
      dugme.onclick = () => Bildirim.kapatVeGoster();
    } else {
      yazi.textContent = 'Bu cihazda kapalı. Açarsanız site kapalıyken bile bildirim gelir.';
      dugme.textContent = 'Bu Cihazda Aç';
      dugme.style.display = '';
      dugme.onclick = () => Bildirim.ac();
    }
  },

  async ac(){
    if(!this.destekVarMi()){ showToast('Bu tarayıcı bildirimi desteklemiyor.', 'error'); return; }
    if(!state.vapidAnahtari){ showToast('Bildirim anahtarı alınamadı, tekrar giriş yapın.', 'error'); return; }

    try {
      const izin = await Notification.requestPermission();
      if(izin !== 'granted'){ showToast('Bildirim izni verilmedi.', 'error'); return; }

      const kayit = await this.kayit();
      await navigator.serviceWorker.ready;

      let abonelik = await kayit.pushManager.getSubscription();
      if(!abonelik){
        abonelik = await kayit.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.b64ToBayt(state.vapidAnahtari)
        });
      }

      await API.post('/api/push-abone', {
        endpoint: abonelik.endpoint,
        p256dh: this.baytaB64(abonelik.getKey('p256dh')),
        auth: this.baytaB64(abonelik.getKey('auth'))
      });

      showToast('Bildirimler bu cihazda açıldı.', 'success');
      this.durumuGoster();
    } catch (e) {
      showToast('Bildirim açılamadı: ' + (e.message || e), 'error');
    }
  },

  /** Aboneliği hem cihazdan hem sunucudan siler. */
  async kapat(){
    const abonelik = await this.mevcutAbonelik();
    if(!abonelik) return;
    const adres = abonelik.endpoint;
    try { await abonelik.unsubscribe(); } catch {}
    try { await API.post('/api/push-cik', { endpoint: adres }); } catch {}
  },

  async kapatVeGoster(){
    await this.kapat();
    showToast('Bildirimler bu cihazda kapatıldı.', 'success');
    this.durumuGoster();
  }
};

// =====================================================================
//  AÇILIŞ
// =====================================================================

/** Sunucuya ulaşılamadığında sayfa boş kalmasın; ne olduğu açıkça yazsın. */
function baglantiHatasiGoster(mesaj){
  const kart = document.getElementById('calendarCard');
  if(!kart) return;
  kart.innerHTML =
    '<div class="card-title">Bağlantı sorunu</div>' +
    '<div class="empty-state"><p>' + escHtml(mesaj) + '</p>' +
    '<p style="margin-top:8px;">Lütfen sayfayı yenileyin. Sorun sürerse bize ulaşın.</p></div>';
}

async function baslat(){
  if(API_TEMEL.includes('KULLANICIADI')){
    baglantiHatasiGoster('Sunucu adresi henüz ayarlanmamış. index.html içindeki API_TEMEL değerini düzenleyin.');
    return;
  }

  try {
    const veri = await API.get('/api/baslangic');
    state.ustalar = veri.ustalar || [];
    state.saatler = veri.saatler || [];
    state.hizmetler = veri.hizmetler || [];
    state.hizmetCakisma = veri.hizmetCakisma || [];
    state.kapaliGunler = veri.kapaliGunler || [];
    state.bugun = veri.bugun || '';
    state.turnstileAnahtari = veri.turnstileAnahtari || null;
  } catch (e) {
    baglantiHatasiGoster(e.message);
    return;
  }

  UI.initCalendar();
  Turnstile.kur();

  // Daha önce giriş yapılmışsa oturumu geri al. Tarayıcı kapanıp açılsa
  // bile şifre tekrar sorulmaz; sadece Çıkış Yap ile düşer.
  // Jeton süreli ve imzalıdır; geçersizse ilk istekte sunucu düşürür.
  const oturum = oturumuOku();
  if(oturum && oturum.jeton){
    state.jeton = oturum.jeton;
    state.isAdmin = true;
    state.kullanici = oturum.kullanici || null;
    state.kullaniciAdi = oturum.ad || null;
    state.rol = oturum.rol || null;
    state.ustaId = oturum.ustaId || null;
    state.vapidAnahtari = oturum.vapidAnahtari || null;
  }

  // Servis görevlisini sessizce kaydet: bildirim izni zaten verilmişse
  // site açılır açılmaz çalışır duruma gelsin.
  if(Bildirim.destekVarMi() && state.isAdmin){
    Bildirim.kayit().catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', baslat);
