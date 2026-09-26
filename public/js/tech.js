(async function () {
  const { staffApi, esc, prettyDate, PREF_LABEL, formatPhone, toast, timeOf, timeAgo } = TV;
  const call = (path, opts) => staffApi(path, opts, 'tech');
  const $ = (id) => document.getElementById(id);

  const cfg = await TV.api('/api/config');
  if (cfg.role === 'admin') $('admin-link').classList.remove('hidden');

  let days = await call('/api/staff/days');
  let view = null;
  let lastPos = null;
  let watchId = null;
  let lastSent = 0;

  // Pick today, else the next upcoming day, else the most recent one.
  const todayStr = new Date().toLocaleDateString('en-CA');
  const params = new URLSearchParams(location.search);
  const initial =
    days.find((d) => String(d.id) === params.get('day')) ||
    days.find((d) => d.status === 'in_progress') ||
    days.find((d) => d.date >= todayStr) ||
    days[days.length - 1];

  function renderDaySelect(selectedId) {
    $('day').innerHTML = days.length
      ? days
          .map(
            (d) =>
              `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${esc(prettyDate(d.date, { short: true }))} — ${d.booked} stop${d.booked === 1 ? '' : 's'}${d.status === 'done' ? ' (done)' : d.status === 'in_progress' ? ' (in progress)' : ''}</option>`
          )
          .join('')
      : '<option value="">No work days yet</option>';
  }
  renderDaySelect(initial?.id);

  const mapCtl = await TVMap.createMap($('map'), cfg);
  $('fit-btn').addEventListener('click', () => mapCtl.fit());

  const navUrl = (s) =>
    `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(
      Number.isFinite(s.lat) ? `${s.lat},${s.lng}` : s.formattedAddress || s.address
    )}`;

  function stopBody(s) {
    return `<div class="title">${esc(s.address)} <span class="pill ${s.timePref}">${PREF_LABEL[s.timePref]}</span></div>
      <div class="small muted">${esc(s.name || '')}${s.name ? ' · ' : ''}<a href="tel:${esc(s.phone)}">${esc(formatPhone(s.phone))}</a>
      ${Number.isFinite(s.lat) ? '' : ' · <span style="color:var(--warn)">not on map</span>'}</div>
      ${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ''}`;
  }

  function render() {
    const { day, queue, completed } = view;
    const statusLabel = { scheduled: 'Not started', in_progress: 'In progress', done: 'Done' }[day.status];
    $('day-status').innerHTML = `<span class="pill ${day.status}">${statusLabel}</span>`;
    $('start-btn').textContent = day.status === 'done' ? '▶ Reopen day' : '▶ Start day';
    $('start-btn').classList.toggle('hidden', day.status === 'in_progress');
    $('end-btn').classList.toggle('hidden', day.status !== 'in_progress');
    $('summary').textContent = `${completed.length} done · ${queue.length} remaining` +
      (day.status === 'scheduled' ? ' · Customers get texts once you start the day.' : '');

    const next = queue[0];
    const nextEl = $('next');
    if (next && day.status !== 'done') {
      nextEl.classList.remove('hidden');
      nextEl.innerHTML = `<p class="muted small" style="margin:0">UP NEXT</p>
        <div class="addr">${esc(next.address)}</div>
        <div class="muted">${esc(next.name || '')}${next.name ? ' · ' : ''}<a href="tel:${esc(next.phone)}">${esc(formatPhone(next.phone))}</a>
          · <span class="pill ${next.timePref}">${PREF_LABEL[next.timePref]}</span></div>
        ${next.notes ? `<div class="note">${esc(next.notes)}</div>` : ''}
        ${queue[1] ? `<p class="small muted" style="margin:8px 0 0">Then: ${esc(queue[1].address)}</p>` : ''}
        <div class="row" style="margin-top:12px">
          <button class="btn-lg grow" data-complete="${next.id}">✓ Mark complete</button>
          <a class="btn btn-secondary btn-lg" href="${navUrl(next)}" target="_blank" rel="noopener">🧭 Navigate</a>
        </div>`;
    } else if (day.status !== 'scheduled' && completed.length && !queue.length) {
      nextEl.classList.remove('hidden');
      nextEl.innerHTML = '<div class="addr">🎉 All stops complete!</div>';
    } else nextEl.classList.add('hidden');

    $('queue-count').textContent = `(${queue.length})`;
    $('queue').innerHTML = queue.length
      ? queue
          .map(
            (s, i) => `${TV.sessionDivider(queue, i)}<div class="stop">
          <div class="num ${s.timePref}">${i + 1}</div>
          <div class="body">${stopBody(s)}
            <div class="actions">
              <button class="btn-sm" data-complete="${s.id}">✓ Complete</button>
              <a class="btn btn-sm btn-secondary" href="${navUrl(s)}" target="_blank" rel="noopener">Navigate</a>
              <button class="btn-sm btn-secondary" data-up="${s.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
              <button class="btn-sm btn-secondary" data-down="${s.id}" ${i === queue.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
              <button class="btn-sm btn-ghost-danger" data-move="${s.id}">Move to next day</button>
            </div>
          </div></div>`
          )
          .join('')
      : '<p class="muted">No stops remaining.</p>';

    $('done-count').textContent = `(${completed.length})`;
    $('completed').innerHTML = completed.length
      ? completed
          .map(
            (s) => `<div class="stop"><div class="num completed">✓</div><div class="body">${stopBody(s)}
            <div class="small muted">Completed ${esc(timeOf(s.completedAt))}${s.techNotes ? ` · ${esc(s.techNotes)}` : ''}</div>
            <div class="actions"><button class="btn-sm btn-secondary" data-undo="${s.id}">Undo</button></div></div></div>`
          )
          .join('')
      : '<p class="muted">Nothing completed yet.</p>';

    mapCtl.update({ queue, completed, techLocation: view.techLocation, startLocation: view.startLocation });
  }

  async function load() {
    const id = $('day').value;
    if (!id) {
      $('queue').innerHTML = '<p class="muted">The administrator has not added any work days yet.</p>';
      return;
    }
    view = await call(`/api/staff/days/${id}`);
    render();
  }

  async function refreshDays() {
    days = await call('/api/staff/days');
    renderDaySelect(Number($('day').value));
  }

  $('day').addEventListener('change', () => {
    history.replaceState(null, '', `?day=${$('day').value}`);
    load();
  });

  $('start-btn').addEventListener('click', async () => {
    view = await call(`/api/staff/days/${view.day.id}/start`, { method: 'POST' });
    toast('Day started. The first two neighbors have been notified.');
    render();
    refreshDays();
    if (!$('share-loc').checked) {
      $('share-loc').checked = true;
      startSharing();
    }
  });

  $('end-btn').addEventListener('click', () => {
    $('end-summary').textContent = view.queue.length
      ? `${view.queue.length} stop(s) are not finished.`
      : 'All stops are finished.';
    $('end-rollover').parentElement.classList.toggle('hidden', !view.queue.length);
    $('end-dlg').showModal();
  });
  $('end-dlg').addEventListener('close', async () => {
    if ($('end-dlg').returnValue !== 'ok') return;
    const res = await call(`/api/staff/days/${view.day.id}/end`, {
      method: 'POST',
      body: { rollover: $('end-rollover').checked },
    });
    view = res.view;
    render();
    refreshDays();
    const unplaced = res.moved.filter((m) => !m.movedTo).length;
    toast(res.moved.length ? `Moved ${res.moved.length - unplaced} stop(s)${unplaced ? `; ${unplaced} need a new day` : ''}.` : 'Day ended.');
  });

  $('optimize-btn').addEventListener('click', async () => {
    const body = lastPos ? { lat: lastPos.lat, lng: lastPos.lng } : {};
    view = await call(`/api/staff/days/${view.day.id}/optimize`, { method: 'POST', body });
    render();
    toast(lastPos ? 'Route re-planned from your location.' : 'Route re-planned (turn on location to plan from where you are).');
  });

  let completingId = null;
  document.body.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.complete) {
        completingId = Number(t.dataset.complete);
        const s = view.queue.find((q) => q.id === completingId);
        $('complete-addr').textContent = s ? s.address : '';
        $('tech-notes').value = '';
        $('complete-dlg').showModal();
      } else if (t.dataset.undo) {
        await call(`/api/staff/signups/${t.dataset.undo}/uncomplete`, { method: 'POST' });
        await load();
      } else if (t.dataset.move) {
        const s = view.queue.find((q) => q.id === Number(t.dataset.move));
        if (!confirm(`Move ${s.address} to the next available day? They'll get a text.`)) return;
        const { day } = await call(`/api/staff/signups/${t.dataset.move}/move-next`, { method: 'POST', body: {} });
        toast(day ? `Moved to ${prettyDate(day.date, { short: true })}.` : 'No open day with room. Marked as needing a new date.');
        await load();
        refreshDays();
      } else if (t.dataset.up || t.dataset.down) {
        const ids = view.queue.map((q) => q.id);
        const idNum = Number(t.dataset.up || t.dataset.down);
        const i = ids.indexOf(idNum);
        const j = t.dataset.up ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        view = await call(`/api/staff/days/${view.day.id}/order`, { method: 'PUT', body: { ids } });
        render();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('complete-dlg').addEventListener('close', async () => {
    if ($('complete-dlg').returnValue !== 'ok' || !completingId) return;
    try {
      await call(`/api/staff/signups/${completingId}/complete`, { method: 'POST', body: { techNotes: $('tech-notes').value } });
      toast('Marked complete. Homeowner notified.');
      await load();
      refreshDays();
    } catch (err) {
      toast(err.message, true);
    }
    completingId = null;
  });

  // ------------------------------------------------ location sharing
  function setLocState(text, on) {
    $('loc-state').textContent = text;
    $('loc-state').className = `small ${on ? 'loc-on' : 'loc-off'}`;
  }

  function startSharing() {
    if (!('geolocation' in navigator)) {
      setLocState('(not supported on this device)', false);
      $('share-loc').checked = false;
      return;
    }
    localStorage.setItem('tv-share-loc', '1');
    setLocState('(waiting for GPS…)', false);
    watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        lastPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        setLocState('(on)', true);
        if (Date.now() - lastSent > 15000) {
          lastSent = Date.now();
          try {
            await call('/api/staff/location', { method: 'POST', body: lastPos });
            if (view) {
              view.techLocation = { ...lastPos, updatedAt: new Date().toISOString() };
              mapCtl.update({ queue: view.queue, completed: view.completed, techLocation: view.techLocation, startLocation: view.startLocation });
            }
          } catch {
            setLocState('(upload failed, retrying)', false);
          }
        }
      },
      (err) => {
        setLocState(err.code === 1 ? '(permission denied — enable location for this site)' : '(unavailable)', false);
        if (err.code === 1) {
          $('share-loc').checked = false;
          localStorage.removeItem('tv-share-loc');
        }
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
    );
  }
  function stopSharing() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    localStorage.removeItem('tv-share-loc');
    setLocState('', false);
  }
  $('share-loc').addEventListener('change', () => ($('share-loc').checked ? startSharing() : stopSharing()));
  if (localStorage.getItem('tv-share-loc') === '1') {
    $('share-loc').checked = true;
    startSharing();
  }

  await load();
  setInterval(() => {
    if (!document.hidden && !$('complete-dlg').open && !$('end-dlg').open) load().catch(() => {});
  }, 30000);
})();
