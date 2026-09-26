/* Google Maps wrapper used by the admin and technician views. */
(function () {
  let loading = null;

  function loadGoogleMaps(key) {
    if (window.google?.maps?.importLibrary) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      window.__tvMapsReady = resolve;
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__tvMapsReady`;
      s.async = true;
      s.onerror = () => reject(new Error('Could not load Google Maps'));
      document.head.appendChild(s);
    });
    return loading;
  }

  const div = (className, text = '') => {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    return el;
  };

  /**
   * Create a map in `el`. Returns {update(data), fit()} or a no-op object when maps are unavailable.
   * data: { queue:[stop], completed:[stop], others:[stop], techLocation, startLocation }
   */
  async function createMap(el, cfg) {
    const noop = { update() {}, fit() {}, ready: false };
    if (!cfg.mapsKey) {
      el.classList.add('map-empty');
      el.innerHTML = '<div>Map unavailable: set <code>GOOGLE_MAPS_API_KEY</code> on the server to enable Google Maps.</div>';
      return noop;
    }
    try {
      await loadGoogleMaps(cfg.mapsKey);
    } catch (err) {
      el.classList.add('map-empty');
      el.textContent = err.message;
      return noop;
    }
    const { Map, InfoWindow, Polyline } = await google.maps.importLibrary('maps');
    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
    const { LatLngBounds } = await google.maps.importLibrary('core');

    const map = new Map(el, {
      center: { lat: 39.5, lng: -98.35 },
      zoom: 4,
      mapId: cfg.mapId || 'DEMO_MAP_ID',
      gestureHandling: 'greedy',
      streetViewControl: false,
      mapTypeControl: false,
    });
    const info = new InfoWindow();
    let markers = [];
    let techMarker = null;
    let line = null;
    let fitted = false;
    let lastPoints = [];

    function marker(position, content, html, zIndex) {
      const m = new AdvancedMarkerElement({ map, position, content, zIndex, gmpClickable: Boolean(html) });
      if (html) m.addListener('click', () => {
        info.setContent(html);
        info.open({ map, anchor: m });
      });
      return m;
    }

    const has = (s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lng);
    const stopHtml = (s, label) => `<div class="iw"><b>${TV.esc(label)}</b><br>${TV.esc(s.name || '')}${s.name ? '<br>' : ''}
      ${TV.esc(s.address)}<br><span class="pill ${s.timePref}">${TV.PREF_LABEL[s.timePref] || ''}</span>
      ${s.assignedDate ? ` <span class="small">${TV.esc(TV.prettyDate(s.assignedDate, { short: true }))}</span>` : ''}
      ${s.completedAt ? `<br>Completed ${TV.esc(TV.timeOf(s.completedAt))}` : ''}
      ${s.notes ? `<div class="note">${TV.esc(s.notes)}</div>` : ''}</div>`;

    function fit() {
      if (!lastPoints.length) return;
      if (lastPoints.length === 1) {
        map.setCenter(lastPoints[0]);
        map.setZoom(16);
        return;
      }
      const b = new LatLngBounds();
      lastPoints.forEach((p) => b.extend(p));
      map.fitBounds(b, 40);
    }

    function update({ queue = [], completed = [], others = [], techLocation = null, startLocation = null } = {}) {
      markers.forEach((m) => (m.map = null));
      markers = [];
      const points = [];

      if (has(startLocation)) {
        markers.push(marker(startLocation, div('mk-start', '🏁'), `<div class="iw"><b>Start</b><br>${TV.esc(startLocation.address || '')}</div>`, 1));
      }
      others.filter(has).forEach((s) => {
        const cls = s.status === 'completed' ? 'completed' : s.status === 'scheduled' ? s.timePref : 'other';
        markers.push(marker(s, div(`mk ${cls}`, s.status === 'completed' ? '✓' : ''), stopHtml(s, s.status), 2));
        points.push(s);
      });
      completed.filter(has).forEach((s) => {
        markers.push(marker(s, div('mk completed', '✓'), stopHtml(s, 'Completed'), 3));
        points.push(s);
      });
      queue.forEach((s, i) => {
        if (!has(s)) return;
        markers.push(marker(s, div(`mk ${s.markerClass || s.timePref}${i === 0 ? ' next' : ''}`, s.label ?? String(i + 1)), stopHtml(s, s.title || (i === 0 ? 'Up next' : `Stop #${i + 1}`)), 100 - i));
        points.push(s);
      });

      const fresh = techLocation && Date.now() - Date.parse(techLocation.updatedAt) < 30 * 60 * 1000;
      if (has(techLocation) && fresh) {
        const pos = { lat: techLocation.lat, lng: techLocation.lng };
        if (!techMarker) techMarker = marker(pos, div('mk-tech'), null, 1000);
        techMarker.position = pos;
        techMarker.map = map;
        techMarker.title = `Technician (updated ${TV.timeAgo(techLocation.updatedAt)})`;
        points.push(pos);
      } else if (techMarker) {
        techMarker.map = null;
      }

      // Route line from the tech (or start point) through the remaining queue.
      const path = [];
      if (has(techLocation) && fresh) path.push({ lat: techLocation.lat, lng: techLocation.lng });
      else if (has(startLocation) && queue.length) path.push({ lat: startLocation.lat, lng: startLocation.lng });
      queue.filter(has).forEach((s) => path.push({ lat: s.lat, lng: s.lng }));
      if (line) line.setMap(null);
      line = path.length > 1
        ? new Polyline({
            map,
            path,
            strokeOpacity: 0,
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeColor: '#1f7a4d', scale: 3 }, offset: '0', repeat: '14px' }],
          })
        : null;

      lastPoints = points;
      if (!fitted && points.length) {
        fit();
        fitted = true;
      }
    }

    return { update, fit, ready: true, map };
  }

  window.TVMap = { createMap };
})();
