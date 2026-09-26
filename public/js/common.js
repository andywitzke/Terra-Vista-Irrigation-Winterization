/* Shared helpers for all pages. */
(function () {
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** Redirect to the login page when a staff API call returns 401. */
  async function staffApi(path, opts, role) {
    try {
      return await api(path, opts);
    } catch (err) {
      if (err.status === 401) {
        location.href = `/login.html?role=${role}&next=${encodeURIComponent(location.pathname + location.search)}`;
        await new Promise(() => {}); // stop further work while navigating
      }
      throw err;
    }
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const PREF_LABEL = { AM: 'Morning', PM: 'Afternoon', ANY: 'Any time' };

  function prettyDate(ymd, opts = {}) {
    if (!ymd) return '';
    return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: opts.short ? 'short' : 'long',
      month: opts.short ? 'short' : 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }

  function formatPhone(e164) {
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
    return new Date(iso).toLocaleString();
  }

  function timeOf(iso) {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  }

  let toastTimer;
  function toast(msg, isError = false) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  function showAlert(el, msg, kind = 'error') {
    if (!el) return;
    if (!msg) {
      el.className = 'hidden';
      el.textContent = '';
      return;
    }
    el.className = `alert ${kind}`;
    el.textContent = msg;
  }

  /**
   * Render the "which days work" picker.
   * @param {HTMLElement} container
   * @param {Array<{id,date,remaining,amRemaining,pmRemaining,full}>} days  (remaining null = unknown)
   * @param {Map<number,string>} selected dayId -> AM|PM|ANY
   */
  function renderDayPicker(container, days, selected = new Map()) {
    if (!days.length) {
      container.innerHTML = '<p class="muted">No dates are open for sign-up right now. Please check back soon.</p>';
      return;
    }
    const left = (n) => (n > 0 ? `${n} left` : 'full');
    container.innerHTML = days
      .map((d) => {
        const sel = selected.has(d.id);
        const known = d.remaining != null;
        // A session they already hold stays selectable even when it's now full.
        const open = {
          AM: !known || d.amRemaining > 0 || selected.get(d.id) === 'AM',
          PM: !known || d.pmRemaining > 0 || selected.get(d.id) === 'PM',
          ANY: !known || d.remaining > 0 || selected.get(d.id) === 'ANY',
        };
        let pref = selected.get(d.id) || 'ANY';
        if (!open[pref]) pref = ['ANY', 'AM', 'PM'].find((p) => open[p]) || pref;
        const disabled = d.full && !sel;
        const spots = !known
          ? ''
          : d.full
            ? 'Full'
            : `Morning ${left(d.amRemaining)} · Afternoon ${left(d.pmRemaining)}`;
        const seg = ['AM', 'PM', 'ANY']
          .map(
            (p) =>
              `<label><input type="radio" name="pref-${d.id}" value="${p}" ${pref === p ? 'checked' : ''} ${open[p] ? '' : 'disabled'}><span>${PREF_LABEL[p]}${open[p] ? '' : ' (full)'}</span></label>`
          )
          .join('');
        return `<div class="day${sel ? ' selected' : ''}${d.full ? ' full' : ''}" data-day="${d.id}">
          <label class="day-head"><input type="checkbox" ${sel ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            ${esc(prettyDate(d.date))}<span class="spots">${spots}</span></label>
          <div class="seg ${sel ? '' : 'hidden'}" role="radiogroup" aria-label="Time of day for ${esc(prettyDate(d.date))}">${seg}</div>
        </div>`;
      })
      .join('');
    container.querySelectorAll('.day').forEach((row) => {
      const cb = row.querySelector('input[type=checkbox]');
      cb.addEventListener('change', () => {
        row.classList.toggle('selected', cb.checked);
        row.querySelector('.seg').classList.toggle('hidden', !cb.checked);
      });
    });
  }

  function readDayPicker(container) {
    return [...container.querySelectorAll('.day')]
      .filter((row) => row.querySelector('input[type=checkbox]').checked)
      .map((row) => ({
        dayId: Number(row.dataset.day),
        timePref: row.querySelector('input[type=radio]:checked')?.value || 'ANY',
      }));
  }

  /** "Morning" / "Afternoon" heading before stop i of a planned queue (only when both halves have stops). */
  function sessionDivider(queue, i) {
    const firstPm = queue.findIndex((q) => q.session === 'PM');
    if (firstPm <= 0) return '';
    if (i === 0) return '<div class="session-divider">Morning</div>';
    return i === firstPm ? '<div class="session-divider">Afternoon</div>' : '';
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  }

  window.TV = {
    api,
    staffApi,
    esc,
    PREF_LABEL,
    prettyDate,
    formatPhone,
    timeAgo,
    timeOf,
    toast,
    showAlert,
    renderDayPicker,
    readDayPicker,
    sessionDivider,
    logout,
  };
})();
