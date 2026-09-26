(async function () {
  const { staffApi, esc, prettyDate, PREF_LABEL, formatPhone, toast, showAlert, renderDayPicker, readDayPicker, timeOf } = TV;
  const call = (path, opts) => staffApi(path, opts, 'admin');
  const $ = (id) => document.getElementById(id);

  const cfg = await TV.api('/api/config');
  let days = [];
  let signups = [];
  let mapCtl = null;
  let activeTab = 'signups';

  const STATUS_LABEL = { scheduled: 'Scheduled', completed: 'Completed', unscheduled: 'Needs a date', cancelled: 'Cancelled' };
  const DAY_STATUS = { scheduled: 'Not started', in_progress: 'In progress', done: 'Done' };
  const dayLabel = (d) => `${prettyDate(d.date, { short: true })} (${d.booked}/${d.capacity})`;

  // ------------------------------------------------------------ tabs
  function showTab(name) {
    activeTab = name;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    history.replaceState(null, '', `#${name}`);
    if (name === 'map') loadMap();
    if (name === 'texts') loadSms();
    if (name === 'settings') loadSettings();
    if (name === 'days') loadDays();
    if (name === 'signups') loadSignups();
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ------------------------------------------------------------ days
  async function refreshDays() {
    days = await call('/api/staff/days');
    const fDay = $('f-day').value;
    $('f-day').innerHTML =
      `<option value="">All dates</option><option value="none">Needs a date</option>` +
      days.map((d) => `<option value="${d.id}">${esc(dayLabel(d))}</option>`).join('');
    $('f-day').value = fDay;
    const mDay = $('m-day').value;
    const todayStr = new Date().toLocaleDateString('en-CA');
    $('m-day').innerHTML =
      `<option value="all">All sign-ups</option>` + days.map((d) => `<option value="${d.id}">${esc(dayLabel(d))}</option>`).join('');
    const defaultDay = days.find((d) => d.status === 'in_progress') || days.find((d) => d.date >= todayStr);
    $('m-day').value = mDay || (defaultDay ? String(defaultDay.id) : 'all');
  }

  async function loadDays() {
    await refreshDays();
    $('day-rows').innerHTML = days.length
      ? days
          .map(
            (d) => `<tr>
        <td><b>${esc(prettyDate(d.date))}</b></td>
        <td>${d.booked}/${d.capacity}${d.full ? ' <span class="pill unscheduled">Full</span>' : ''}
          <div class="small muted">Morning ${d.bookedAm} · Afternoon ${d.bookedPm} · Any time ${d.bookedAny}${d.completed ? ` · ${d.completed} done` : ''}</div></td>
        <td><input type="number" min="0" max="100" value="${d.am_capacity}" data-am="${d.id}" class="cap-input" aria-label="Morning limit"></td>
        <td><input type="number" min="0" max="100" value="${d.pm_capacity}" data-pm="${d.id}" class="cap-input" aria-label="Afternoon limit"></td>
        <td><input type="checkbox" data-open="${d.id}" ${d.is_open ? 'checked' : ''} aria-label="Open to public"></td>
        <td><span class="pill ${d.status}">${DAY_STATUS[d.status]}</span></td>
        <td class="actions">
          <a class="btn btn-sm btn-secondary" href="/tech.html?day=${d.id}">Tech view</a>
          <button class="btn-sm btn-secondary" data-dmap="${d.id}">Map</button>
          <button class="btn-sm btn-secondary" data-rollover="${d.id}" title="Move unfinished stops to their next available day">Roll over unfinished</button>
          ${d.status !== 'scheduled' ? `<button class="btn-sm btn-secondary" data-reset="${d.id}">Reset status</button>` : ''}
          <button class="btn-sm btn-ghost-danger" data-deleteday="${d.id}">Delete</button>
        </td></tr>`
          )
          .join('')
      : '<tr><td colspan="7" class="muted">No dates yet. Add the first one above.</td></tr>';
  }

  $('add-days-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const start = $('d-start').value;
    const end = $('d-end').value || start;
    if (!start) return;
    const dates = [];
    for (let d = new Date(`${start}T12:00:00Z`); d <= new Date(`${end}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (start === end || $('d-weekends').checked || (dow !== 0 && dow !== 6)) dates.push(d.toISOString().slice(0, 10));
    }
    if (dates.length > 60) return toast('That range is more than 60 days.', true);
    await call('/api/admin/days', {
      method: 'POST',
      body: { dates, amCapacity: Number($('d-am').value), pmCapacity: Number($('d-pm').value) },
    });
    toast(`Added ${dates.length} date(s).`);
    $('d-start').value = '';
    $('d-end').value = '';
    loadDays();
  });

  $('day-rows').addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.am) await call(`/api/admin/days/${t.dataset.am}`, { method: 'PUT', body: { amCapacity: Number(t.value) } });
      if (t.dataset.pm) await call(`/api/admin/days/${t.dataset.pm}`, { method: 'PUT', body: { pmCapacity: Number(t.value) } });
      if (t.dataset.open) await call(`/api/admin/days/${t.dataset.open}`, { method: 'PUT', body: { isOpen: t.checked } });
      toast('Saved.');
      loadDays();
    } catch (err) {
      toast(err.message, true);
      loadDays();
    }
  });

  // ------------------------------------------------------------ sign-ups
  async function loadSignups() {
    await refreshDays();
    const qs = new URLSearchParams();
    if ($('f-day').value) qs.set('dayId', $('f-day').value);
    if ($('f-status').value) qs.set('status', $('f-status').value);
    signups = await call(`/api/admin/signups?${qs}`);
    $('export-btn').href = `/api/admin/export.csv?${qs}`;
    renderSignups();
  }

  function renderSignups() {
    const q = $('f-search').value.trim().toLowerCase();
    const rows = q
      ? signups.filter((s) => `${s.name} ${s.address} ${s.phone} ${formatPhone(s.phone)} ${s.notes}`.toLowerCase().includes(q))
      : signups;
    const count = (st) => rows.filter((s) => s.status === st).length;
    $('stats').innerHTML = [
      ['Total', rows.length],
      ['Scheduled', count('scheduled')],
      ['Completed', count('completed')],
      ['Needs a date', count('unscheduled')],
      ['Not on map', rows.filter((s) => !Number.isFinite(s.lat) && s.status !== 'cancelled').length],
    ]
      .map(([l, n]) => `<span class="stat"><span class="small muted">${l}</span><b>${n}</b></span>`)
      .join('');
    $('signup-rows').innerHTML = rows.length
      ? rows
          .map(
            (s) => `<tr>
        <td>${s.assignedDate ? esc(prettyDate(s.assignedDate, { short: true })) : '<span class="muted">—</span>'}</td>
        <td>${s.status === 'scheduled' && s.routeOrder ? s.routeOrder : ''}</td>
        <td><span class="pill ${s.timePref}">${PREF_LABEL[s.timePref]}</span>${s.timePref === 'ANY' && s.session && s.status === 'scheduled' ? `<div class="small muted">→ ${s.session === 'AM' ? 'morning' : 'afternoon'}</div>` : ''}</td>
        <td><b>${esc(s.name || '')}</b>${s.name ? '<br>' : ''}${esc(s.address)}
          ${Number.isFinite(s.lat) ? '' : `<br><span class="small" style="color:var(--warn)">Not located</span> <button class="link small" data-geo="${s.id}">retry</button>`}</td>
        <td><a href="tel:${esc(s.phone)}">${esc(formatPhone(s.phone))}</a>${s.smsOptIn ? '' : '<br><span class="small muted">no texts</span>'}</td>
        <td class="small">${esc(s.notes)}${s.techNotes ? `<div class="note">Tech: ${esc(s.techNotes)}</div>` : ''}</td>
        <td class="small">${s.prefs.map((p) => `${esc(prettyDate(p.date, { short: true }))} ${p.timePref}`).join('<br>')}</td>
        <td><span class="pill ${s.status}">${STATUS_LABEL[s.status]}</span>${s.completedAt ? `<br><span class="small muted">${esc(timeOf(s.completedAt))}</span>` : ''}</td>
        <td class="actions">
          <button class="btn-sm btn-secondary" data-edit="${s.id}">Edit</button>
          ${s.status === 'scheduled' || s.status === 'unscheduled' ? `<button class="btn-sm btn-secondary" data-next="${s.id}" title="Move to next available day">Next day →</button>` : ''}
          <button class="btn-sm btn-ghost-danger" data-del="${s.id}" aria-label="Delete">✕</button>
        </td></tr>`
          )
          .join('')
      : '<tr><td colspan="9" class="muted">No sign-ups match.</td></tr>';
  }

  $('f-day').addEventListener('change', loadSignups);
  $('f-status').addEventListener('change', loadSignups);
  $('f-search').addEventListener('input', renderSignups);

  // ------------------------------------------------------------ edit dialog
  let editing = null; // signup object or {} for new

  function openEditor(s) {
    editing = s;
    const isNew = !s.id;
    $('edit-title').textContent = isNew ? 'Add sign-up' : 'Edit sign-up';
    $('e-name').value = s.name || '';
    $('e-phone').value = s.phone ? formatPhone(s.phone) : '';
    $('e-address').value = s.address || '';
    $('e-geo').textContent = s.id ? (s.formattedAddress ? `📍 ${s.formattedAddress}` : '⚠ Not located on the map') : '';
    $('e-notes').value = s.notes || '';
    $('e-technotes').value = s.techNotes || '';
    $('e-day').innerHTML =
      `<option value="">— Not scheduled —</option>` +
      days.map((d) => `<option value="${d.id}">${esc(dayLabel(d))}${d.status === 'done' ? ' · done' : ''}</option>`).join('');
    $('e-day').value = s.assignedDayId ? String(s.assignedDayId) : '';
    $('e-pref').value = s.timePref || 'ANY';
    $('e-status').value = s.status || 'scheduled';
    $('e-status-wrap').classList.toggle('hidden', isNew);
    $('e-sms').checked = s.id ? s.smsOptIn : true;
    $('e-over').checked = false;
    $('e-notify').checked = isNew;
    $('e-notify-label').textContent = isNew ? 'Send confirmation text' : 'Text them if their date changes';
    renderDayPicker(
      $('e-days'),
      days
        .filter((d) => d.status !== 'done')
        .map((d) => ({ id: d.id, date: d.date, remaining: d.remaining, amRemaining: d.amRemaining, pmRemaining: d.pmRemaining, full: false })),
      new Map((s.prefs || []).map((p) => [p.dayId, p.timePref]))
    );
    showAlert($('edit-err'), '');
    $('edit-dlg').showModal();
  }

  $('add-btn').addEventListener('click', () => openEditor({}));

  $('edit-form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const body = {
      name: $('e-name').value,
      phone: $('e-phone').value,
      address: $('e-address').value,
      notes: $('e-notes').value,
      techNotes: $('e-technotes').value,
      assignedDayId: $('e-day').value ? Number($('e-day').value) : null,
      timePref: $('e-pref').value,
      smsOptIn: $('e-sms').checked,
      allowOverCapacity: $('e-over').checked,
      prefs: readDayPicker($('e-days')),
    };
    try {
      if (editing.id) {
        body.status = $('e-status').value;
        body.notify = $('e-notify').checked;
        await call(`/api/admin/signups/${editing.id}`, { method: 'PUT', body });
      } else {
        body.sendConfirmation = $('e-notify').checked;
        await call('/api/admin/signups', { method: 'POST', body });
      }
      $('edit-dlg').close();
      toast('Saved.');
      loadSignups();
    } catch (err) {
      showAlert($('edit-err'), err.message);
    }
  });

  document.body.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.edit) openEditor(signups.find((s) => s.id === Number(t.dataset.edit)));
      else if (t.dataset.del) {
        const s = signups.find((x) => x.id === Number(t.dataset.del));
        if (!confirm(`Permanently delete the sign-up for ${s.address}? (No text is sent.)`)) return;
        await call(`/api/admin/signups/${s.id}`, { method: 'DELETE' });
        toast('Deleted.');
        loadSignups();
      } else if (t.dataset.next) {
        const { day } = await call(`/api/staff/signups/${t.dataset.next}/move-next`, { method: 'POST', body: {} });
        toast(day ? `Moved to ${prettyDate(day.date, { short: true })}.` : 'No open day with room — marked "Needs a date".');
        loadSignups();
      } else if (t.dataset.geo) {
        await call(`/api/admin/signups/${t.dataset.geo}/geocode`, { method: 'POST' });
        toast('Located.');
        loadSignups();
      } else if (t.dataset.rollover) {
        if (!confirm('Move every unfinished stop on this day to its next available day and text them?')) return;
        const { moved } = await call(`/api/staff/days/${t.dataset.rollover}/rollover`, { method: 'POST' });
        const unplaced = moved.filter((m) => !m.movedTo).length;
        toast(`Moved ${moved.length - unplaced} stop(s).${unplaced ? ` ${unplaced} need a date.` : ''}`);
        loadDays();
      } else if (t.dataset.reset) {
        await call(`/api/admin/days/${t.dataset.reset}`, { method: 'PUT', body: { status: 'scheduled', routeLocked: false } });
        loadDays();
      } else if (t.dataset.deleteday) {
        const d = days.find((x) => x.id === Number(t.dataset.deleteday));
        if (!confirm(`Delete ${prettyDate(d.date)}?`)) return;
        try {
          await call(`/api/admin/days/${d.id}`, { method: 'DELETE' });
        } catch (err) {
          if (err.status !== 409 || !confirm(`${err.message}\n\nDelete anyway? Those neighbors will be marked "Needs a date".`)) throw err;
          await call(`/api/admin/days/${d.id}?force=1`, { method: 'DELETE' });
        }
        toast('Deleted.');
        loadDays();
      } else if (t.dataset.dmap) {
        $('m-day').value = t.dataset.dmap;
        showTab('map');
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ------------------------------------------------------------ map
  async function loadMap() {
    if (!mapCtl) mapCtl = await TVMap.createMap($('map'), cfg);
    const sel = $('m-day').value;
    if (sel === 'all' || !sel) {
      const [all, loc, settings] = await Promise.all([
        call('/api/admin/signups'),
        call('/api/staff/location'),
        call('/api/admin/settings'),
      ]);
      mapCtl.update({ others: all, techLocation: loc, startLocation: settings.startLocation });
      $('m-summary').textContent = `${all.length} sign-ups · ${all.filter((s) => !Number.isFinite(s.lat)).length} not located`;
      $('m-queue-card').classList.add('hidden');
      return;
    }
    const view = await call(`/api/staff/days/${sel}`);
    mapCtl.update(view);
    const loc = view.techLocation;
    $('m-summary').textContent = `${DAY_STATUS[view.day.status]} · ${view.completed.length} done · ${view.queue.length} remaining` +
      (loc ? ` · Tech location updated ${TV.timeAgo(loc.updatedAt)}` : ' · Tech location not shared');
    $('m-queue-card').classList.remove('hidden');
    $('m-queue').innerHTML = view.queue.length
      ? view.queue
          .map(
            (s, i) => `${TV.sessionDivider(view.queue, i)}<div class="stop"><div class="num ${s.timePref}">${i + 1}</div><div class="body">
          <div class="title">${esc(s.address)} <span class="pill ${s.timePref}">${PREF_LABEL[s.timePref]}</span></div>
          <div class="small muted">${esc(s.name || '')} ${esc(formatPhone(s.phone))}
          ${s.notifiedNext ? ' · texted "next"' : s.notifiedSecond ? ' · texted "2nd"' : ''}</div></div></div>`
          )
          .join('')
      : '<p class="muted">No stops remaining.</p>';
  }
  $('m-day').addEventListener('change', loadMap);
  $('m-fit').addEventListener('click', () => mapCtl && mapCtl.fit());
  setInterval(() => {
    if (activeTab === 'map' && !document.hidden) loadMap().catch(() => {});
  }, 20000);

  // ------------------------------------------------------------ texts
  async function loadSms() {
    const rows = await call('/api/admin/sms-log');
    $('sms-rows').innerHTML = rows.length
      ? rows
          .map(
            (r) => `<tr><td class="small">${esc(new Date(`${r.created_at.replace(' ', 'T')}Z`).toLocaleString())}</td>
          <td>${esc(formatPhone(r.to_phone))}${r.address ? `<br><span class="small muted">${esc(r.address)}</span>` : ''}</td>
          <td>${esc(r.kind)}</td><td class="small">${esc(r.body)}</td>
          <td><span class="pill ${r.status === 'sent' ? 'completed' : r.status === 'failed' ? 'cancelled' : ''}">${esc(r.status)}</span>
          ${r.error ? `<br><span class="small" style="color:var(--danger)">${esc(r.error)}</span>` : ''}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="5" class="muted">No texts yet.</td></tr>';
  }

  // ------------------------------------------------------------ settings
  async function loadSettings() {
    const s = await call('/api/admin/settings');
    $('s-start').value = s.startLocation?.address || '';
    $('s-start-resolved').textContent = s.startLocation ? `📍 ${s.startLocation.formattedAddress}` : '';
    const item = (ok, label, hint) => `<li>${ok ? '✅' : '⚠️'} ${label}${ok ? '' : ` — <span class="muted">${hint}</span>`}</li>`;
    $('integrations').innerHTML = [
      item(s.smsEnabled, 'Twilio text messages', 'not configured; texts are logged but not sent'),
      item(s.mapsConfigured, 'Google Maps (browser)', 'set GOOGLE_MAPS_API_KEY'),
      item(s.geocodingConfigured, 'Google Geocoding (server)', 'set GOOGLE_MAPS_API_KEY or GOOGLE_MAPS_SERVER_KEY'),
      `<li>Links in texts point to <code>${esc(s.baseUrl)}</code></li>`,
      s.addressSuffix ? `<li>Addresses are geocoded with “${esc(s.addressSuffix)}” appended</li>` : '',
    ].join('');
  }
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await call('/api/admin/settings', { method: 'PUT', body: { startAddress: $('s-start').value } });
      toast('Saved.');
      loadSettings();
    } catch (err) {
      toast(err.message, true);
    }
  });

  const TABS = ['signups', 'days', 'map', 'texts', 'settings'];
  const tabFromHash = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'signups');
  window.addEventListener('hashchange', () => tabFromHash() !== activeTab && showTab(tabFromHash()));
  showTab(tabFromHash());
})();
