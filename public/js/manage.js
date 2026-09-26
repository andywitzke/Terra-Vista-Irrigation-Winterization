(async function () {
  const { api, esc, prettyDate, PREF_LABEL, showAlert, renderDayPicker, readDayPicker } = TV;
  const token = new URLSearchParams(location.search).get('t');
  const $ = (id) => document.getElementById(id);
  let current = null;
  let refreshTimer = null;

  const cfg = await api('/api/config').catch(() => ({}));
  if (cfg.neighborhoodName) document.querySelectorAll('[data-neighborhood]').forEach((el) => (el.textContent = cfg.neighborhoodName));

  let progressMap = null;

  async function renderProgress(s) {
    const p = s.progress;
    const card = $('progress-card');
    if (!p) return card.classList.add('hidden');
    card.classList.remove('hidden');
    const stat = (label, n) => `<span class="stat"><span class="small muted">${label}</span><b>${n}</b></span>`;
    const stats = [stat('Houses done', p.completed), stat('Still to go', p.remaining)];
    if (p.stopsBefore !== null) stats.push(stat('Stops before yours', p.stopsBefore));
    $('progress-stats').innerHTML = stats.join('');
    $('progress-card').querySelector('h2').textContent = p.dayStatus === 'done' ? 'Service day finished' : "Today's progress";
    $('progress-note').textContent =
      p.dayStatus === 'done'
        ? 'The technician has finished for the day.'
        : p.techLocation
          ? `Technician location updated ${TV.timeAgo(p.techLocation.updatedAt)}. This page refreshes every 30 seconds.`
          : "The technician's location isn't available right now. This page refreshes every 30 seconds.";
    const showMap = p.home || p.techLocation;
    $('progress-map').classList.toggle('hidden', !showMap);
    $('progress-legend').classList.toggle('hidden', !showMap);
    if (!showMap) return;
    if (!progressMap) progressMap = await TVMap.createMap($('progress-map'), cfg);
    const home = p.home && s.status !== 'completed'
      ? [{ ...p.home, address: s.address, timePref: s.timePref, label: '🏠', markerClass: 'ANY', title: 'Your house' }]
      : [];
    const done = p.home && s.status === 'completed' ? [{ ...p.home, address: s.address, timePref: s.timePref, completedAt: s.completedAt }] : [];
    progressMap.update({ queue: home, completed: done, techLocation: p.techLocation });
  }

  if (!token) return showAlert($('load-error'), 'This link is missing its code. Use the link from your text message.');

  function renderStatus(s) {
    const head = $('status-headline');
    const detail = $('status-detail');
    $('status-address').textContent = s.formattedAddress || s.address;
    const day = s.assignedDay;
    if (s.status === 'completed') {
      head.textContent = '✅ Your system has been winterized';
      detail.innerHTML = `Completed ${esc(new Date(s.completedAt).toLocaleString())}.` +
        (s.techNotes ? `<div class="note">Technician notes: ${esc(s.techNotes)}</div>` : '');
    } else if (s.status === 'unscheduled') {
      head.textContent = 'Waiting to be scheduled';
      detail.textContent = "We'll text you as soon as you have a new date. You can also pick different days below.";
    } else if (day && day.status === 'in_progress' && s.queuePosition) {
      head.textContent =
        s.queuePosition === 1 ? "🚚 You're next!" : s.queuePosition === 2 ? "You're 2nd in line" : `You're #${s.queuePosition} in line today`;
      detail.textContent = s.queuePosition === 1
        ? 'Our technician is on the way. Please make sure gates are unlocked and the valve is accessible.'
        : `Work is underway today (${PREF_LABEL[s.timePref].toLowerCase()} preference).`;
    } else if (day) {
      head.textContent = `${prettyDate(day.date)} · ${PREF_LABEL[s.timePref]}`;
      detail.textContent = s.smsOptIn
        ? "We'll text you when you're 2nd in line, when you're next, and when it's done."
        : 'Text updates are off. Check back here on service day.';
    }
    $('status-card').classList.remove('hidden');
  }

  async function renderForm(s) {
    $('name').value = s.name;
    $('phone').value = TV.formatPhone(s.phone);
    $('address').value = s.address;
    $('notes').value = s.notes;
    $('smsOptIn').checked = s.smsOptIn;
    const locked = s.assignedDay && s.assignedDay.status !== 'scheduled';
    $('days-block').classList.toggle('hidden', locked);
    $('days-locked').classList.toggle('hidden', !locked);
    $('address').disabled = locked;
    if (!locked) {
      const open = await api('/api/days').catch(() => []);
      const ids = new Set(open.map((d) => d.id));
      const extra = s.prefs.filter((p) => !ids.has(p.dayId)).map((p) => ({ id: p.dayId, date: p.date, remaining: null, full: false }));
      const days = [...open, ...extra].sort((a, b) => a.date.localeCompare(b.date));
      renderDayPicker($('days'), days, new Map(s.prefs.map((p) => [p.dayId, p.timePref])));
    }
    $('edit-form').classList.toggle('hidden', s.status === 'completed');
  }

  async function load({ withForm = true } = {}) {
    try {
      current = await api(`/api/signups/${encodeURIComponent(token)}`);
    } catch (err) {
      return showAlert($('load-error'), err.status === 404 ? "We couldn't find that registration. Check the link in your text." : err.message);
    }
    if (current.status === 'cancelled') {
      $('status-card').classList.add('hidden');
      $('edit-form').classList.add('hidden');
      $('cancelled-card').classList.remove('hidden');
      return;
    }
    renderStatus(current);
    await renderProgress(current);
    if (withForm) await renderForm(current);
    clearTimeout(refreshTimer);
    if (current.assignedDay?.status === 'in_progress' && current.status === 'scheduled') {
      refreshTimer = setTimeout(() => load({ withForm: false }), 30000);
    }
  }
  await load();

  $('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('name').value,
      phone: $('phone').value,
      address: $('address').value,
      notes: $('notes').value,
      smsOptIn: $('smsOptIn').checked,
    };
    if (!body.name.trim()) return showAlert($('form-msg'), 'Please enter your name.');
    if (!$('days-block').classList.contains('hidden')) {
      body.prefs = readDayPicker($('days'));
      if (!body.prefs.length) return showAlert($('form-msg'), 'Please choose at least one date.');
    }
    try {
      current = await api(`/api/signups/${encodeURIComponent(token)}`, { method: 'PUT', body });
      showAlert($('form-msg'), 'Saved!', 'ok');
      renderStatus(current);
      await renderProgress(current);
      await renderForm(current);
    } catch (err) {
      showAlert($('form-msg'), err.message);
    }
  });

  $('cancel-btn').addEventListener('click', async () => {
    if (!confirm('Cancel your winterization sign-up?')) return;
    try {
      await api(`/api/signups/${encodeURIComponent(token)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      showAlert($('form-msg'), err.message);
    }
  });
})();
