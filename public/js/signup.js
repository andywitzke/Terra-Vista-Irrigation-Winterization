(async function () {
  const { api, renderDayPicker, readDayPicker, showAlert, prettyDate, PREF_LABEL } = TV;
  const daysEl = document.getElementById('days');
  const form = document.getElementById('signup-form');
  const errEl = document.getElementById('form-error');
  const val = (id) => document.getElementById(id).value;

  const cfg = await api('/api/config').catch(() => ({}));
  if (cfg.neighborhoodName) document.querySelectorAll('[data-neighborhood]').forEach((el) => (el.textContent = cfg.neighborhoodName));

  async function loadDays(keep = new Map()) {
    try {
      renderDayPicker(daysEl, await api('/api/days'), keep);
    } catch (err) {
      daysEl.innerHTML = `<p class="alert error">Could not load dates: ${TV.esc(err.message)}</p>`;
    }
  }
  await loadDays();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showAlert(errEl, '');
    const prefs = readDayPicker(daysEl);
    const body = {
      name: val('name'),
      phone: val('phone'),
      address: val('address'),
      notes: val('notes'),
      smsOptIn: document.getElementById('smsOptIn').checked,
      prefs,
    };
    if (!body.address.trim()) return showAlert(errEl, 'Please enter your street address.');
    if (body.phone.replace(/\D/g, '').length < 10) return showAlert(errEl, 'Please enter a 10-digit mobile phone number.');
    if (!prefs.length) return showAlert(errEl, 'Please choose at least one date that works for you.');

    const btn = document.getElementById('submit');
    btn.disabled = true;
    btn.textContent = 'Signing up…';
    try {
      const s = await api('/api/signups', { method: 'POST', body });
      document.getElementById('form-section').classList.add('hidden');
      document.getElementById('success-section').classList.remove('hidden');
      document.getElementById('success-when').textContent = s.assignedDay
        ? `${prettyDate(s.assignedDay.date)} · ${PREF_LABEL[s.timePref]}`
        : 'We will confirm your date soon.';
      document.getElementById('success-address').textContent = s.formattedAddress || s.address;
      document.getElementById('success-sms').textContent = s.smsOptIn
        ? `We texted a confirmation to ${TV.formatPhone(s.phone)}.`
        : 'Text updates are off. Check this page for updates.';
      const link = document.getElementById('success-link');
      link.href = s.manageUrl;
      link.textContent = s.manageUrl;
      document.getElementById('success-manage').href = s.manageUrl;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      showAlert(errEl, err.message);
      if (err.status === 409) loadDays(new Map(prefs.map((p) => [p.dayId, p.timePref])));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign me up';
    }
  });

  document.getElementById('resend-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('resend-msg');
    try {
      await api('/api/resend-link', { method: 'POST', body: { phone: document.getElementById('resend-phone').value } });
      showAlert(msg, "If that number is registered, we've texted you a link.", 'ok');
    } catch (err) {
      showAlert(msg, err.message);
    }
  });
})();
