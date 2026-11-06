const $ = (id) => document.getElementById(id);
let setupRequired = false;
let signedIn = false;
let refreshing = false;
let deviceSnapshot = '';
let keySnapshot = '';
let activitySnapshot = '';
let noticeTimer;

function notify(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = `toast${error ? ' error' : ''}`;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6500);
}
async function api(path, { method = 'GET', body, key, idempotency } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  if (idempotency) headers['Idempotency-Key'] = idempotency;
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path.startsWith('/api/admin/')) showAuth(false);
    throw new Error(`${value.message || 'Request failed.'}${response.status === 429 ? ` Retry after ${response.headers.get('Retry-After') || 'a few'} seconds.` : ''}`);
  }
  return value;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function status(value) {
  const good = ['connected', 'verified', 'delivered', 'read'];
  const bad = ['logged_out', 'wrong_number', 'failed', 'locked', 'delivery_unknown'];
  return element('span', value.replaceAll('_', ' '), `pill${good.includes(value) ? ' good' : bad.includes(value) ? ' bad' : ''}`);
}
function action(label, fn, className = 'quiet') {
  const button = element('button', label, className);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await fn(); }
    catch (err) { notify(err.message, true); }
    finally { button.disabled = false; }
  });
  return button;
}
function bindForm(id, fn) {
  $(id).addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $(id).querySelector('button[type=submit]');
    if (button.disabled) return;
    button.disabled = true;
    try { await fn(Object.fromEntries(new FormData(event.target)), event.target); }
    catch (err) { notify(err.message, true); }
    finally { button.disabled = false; }
  });
}
function showAuth(setup) {
  signedIn = false;
  setupRequired = setup;
  $('loading').hidden = true;
  $('auth').hidden = false;
  $('workspace').hidden = true;
  $('logout').hidden = true;
  $('docs-link').hidden = true;
  $('setup-label').hidden = !setup;
  $('setup-label').querySelector('input').required = setup;
  $('auth-title').textContent = setup ? 'Make it yours.' : 'Welcome back.';
  $('auth-description').textContent = setup ? 'Register the single owner of this self-hosted installation.' : 'Sign in to manage sending numbers and OTP integrations.';
  $('auth-submit').textContent = setup ? 'Create owner account →' : 'Sign in →';
  $('auth-form').elements.password.minLength = setup ? 12 : 1;
  $('auth-form').elements.password.autocomplete = setup ? 'new-password' : 'current-password';
  $('playground-key').value = '';
  $('new-key').value = '';
  $('secret-dialog').close();
  $('device-list').replaceChildren();
  deviceSnapshot = ''; keySnapshot = ''; activitySnapshot = '';
}
async function showWorkspace() {
  signedIn = true;
  $('loading').hidden = true;
  $('auth').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('docs-link').hidden = false;
  await refresh();
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); notify('Copied.'); }
  catch { notify('Clipboard unavailable. Select and copy the value manually.', true); }
}
function renderDevices(devices) {
  const snapshot = JSON.stringify(devices);
  if (snapshot === deviceSnapshot) return;
  deviceSnapshot = snapshot;
  const container = $('device-list');
  container.replaceChildren();
  if (!devices.length) container.append(element('p', 'No sending numbers yet. Add a spare number above to get started.', 'empty'));
  for (const device of devices) {
    const card = element('article', undefined, 'device-card');
    const top = element('div', undefined, 'device-top');
    top.append(element('h3', device.label), status(device.status));
    card.append(top, element('p', device.phone, 'mono'), element('div', device.id, 'device-id'));
    const buttons = element('div', undefined, 'actions');
    buttons.append(action('Copy ID', () => copy(device.id)));
    if (!['connected', 'connecting', 'reconnecting', 'awaiting_pairing', 'logged_out', 'wrong_number'].includes(device.status)) {
      for (const [mode, label] of [['qr', 'Pair QR'], ['code', 'Pair code']]) buttons.append(action(label, async () => {
        await api(`/api/admin/devices/${device.id}/connect`, { method: 'POST', body: { mode } });
        notify('Connecting. Pairing details will appear shortly.'); await refresh();
      }));
    }
    buttons.append(action('Remove', async () => {
      if (!confirm('Remove this sending number and delete its local WhatsApp session? If remote logout fails, also unlink it on your phone.')) return;
      await api(`/api/admin/devices/${device.id}`, { method: 'DELETE' });
      notify('Number removed.'); await refresh();
    }, 'quiet danger'));
    card.append(buttons);
    if (device.qr) {
      const img = element('img', undefined, 'qr');
      img.src = device.qr; img.alt = 'Private WhatsApp pairing QR'; img.width = 280; img.height = 280;
      card.append(img, element('p', 'WhatsApp → Settings → Linked devices → Link a device. Scan with the registered number.', 'fine'));
    }
    if (device.pairingCode) card.append(element('code', device.pairingCode, 'pairing-code'), element('p', 'WhatsApp → Linked devices → Link a device → Link with phone number instead.', 'fine'));
    if (device.error) card.append(element('p', device.error, 'danger'));
    container.append(card);
  }
  const selected = $('playground-device').value;
  const select = $('playground-device');
  select.replaceChildren(new Option('Select a connected number', ''));
  for (const d of devices.filter((d) => d.status === 'connected')) select.add(new Option(`${d.label} · ${d.phone}`, d.id));
  if ([...select.options].some((o) => o.value === selected)) select.value = selected;
}
function renderKeys(keys) {
  const snapshot = JSON.stringify(keys);
  if (snapshot === keySnapshot) return;
  keySnapshot = snapshot;
  $('key-list').replaceChildren();
  const active = keys.filter((k) => !k.revoked);
  if (!active.length) $('key-list').append(element('p', 'No active API keys. Create one for each application.', 'empty'));
  for (const key of active) {
    const row = element('div', undefined, 'key-row');
    const info = element('div');
    info.append(element('strong', key.name), element('small', `${key.prefix}… · Created ${new Date(key.created).toLocaleDateString()}`));
    row.append(info, action('Revoke', async () => {
      if (!confirm(`Revoke access for ${key.name}? This cannot be undone.`)) return;
      await api(`/api/admin/keys/${key.id}`, { method: 'DELETE' });
      notify('API key revoked.'); await refresh();
    }, 'quiet danger'));
    $('key-list').append(row);
  }
}
function renderActivity(requests) {
  const snapshot = JSON.stringify(requests);
  if (snapshot === activitySnapshot) return;
  activitySnapshot = snapshot;
  $('activity-list').replaceChildren();
  for (const r of requests) {
    const row = element('tr');
    const id = element('td', `${r.requestId.slice(0, 8)}…`, 'mono'); id.title = r.requestId;
    const state = element('td'); state.append(status(r.state));
    const delivery = element('td'); delivery.append(status(r.delivery));
    row.append(id, element('td', r.recipient, 'mono'), state, delivery, element('td', new Date(r.expiresAt).toLocaleString()));
    $('activity-list').append(row);
  }
  if (!requests.length) {
    const row = element('tr'); const cell = element('td', 'No OTP requests yet. Your first real request will appear here.', 'muted');
    cell.colSpan = 5; row.append(cell); $('activity-list').append(row);
  }
}
async function refresh() {
  if (!signedIn || refreshing) return;
  refreshing = true;
  try {
    const data = await api('/api/admin/overview');
    if (!signedIn) return;
    renderDevices(data.devices); renderKeys(data.apiKeys); renderActivity(data.requests);
    $('stat-devices').textContent = data.devices.filter((d) => d.status === 'connected').length;
    $('stat-requests').textContent = data.requests.length;
    $('stat-verified').textContent = data.requests.filter((r) => r.state === 'verified').length;
    $('stat-keys').textContent = data.apiKeys.filter((k) => !k.revoked).length;
    const settings = data.settings;
    const fields = [['Code expiry', `${settings.otpTtlSeconds}s`], ['Verification attempts', settings.maxAttempts], ['Resend cooldown', `${settings.resendCooldownSeconds}s`], ['Requests / app / minute', settings.appPerMinute], ['Requests / app / 24h', settings.appPerDay], ['Requests / recipient / hour', settings.recipientPerHour], ['Requests / device / minute', settings.devicePerMinute], ['Metadata retention', `${settings.metadataRetentionHours}h`]];
    $('settings-list').replaceChildren(...fields.map(([name, value]) => { const div = element('div'); div.append(element('dt', name), element('dd', String(value))); return div; }));
  } finally { refreshing = false; }
}

bindForm('auth-form', async (values, form) => {
  if (setupRequired) {
    await api('/api/setup', { method: 'POST', body: values });
    form.reset(); showAuth(false); notify('Owner registered. Sign in with your new account.');
  } else {
    await api('/api/login', { method: 'POST', body: { email: values.email, password: values.password } });
    form.reset(); await showWorkspace();
  }
});
bindForm('device-form', async (values, form) => { await api('/api/admin/devices', { method: 'POST', body: values }); form.reset(); notify('Number added. Choose QR or pairing code to activate it.'); await refresh(); });
bindForm('key-form', async (values, form) => {
  const result = await api('/api/admin/keys', { method: 'POST', body: values });
  form.reset(); $('new-key').value = result.key; $('secret-dialog').showModal(); await refresh();
});
$('secret-dialog').addEventListener('close', () => { $('new-key').value = ''; });
$('copy-key').addEventListener('click', () => copy($('new-key').value));
$('logout').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); showAuth(false); } catch (err) { notify(err.message, true); } });
$('refresh').addEventListener('click', () => refresh().catch((err) => notify(err.message, true)));
bindForm('password-form', async (values, form) => { await api('/api/admin/password', { method: 'POST', body: values }); form.reset(); showAuth(false); notify('Password updated. All sessions have been signed out.'); });
let pendingRequest = null;
bindForm('request-form', async (values) => {
  const payload = { deviceId: values.deviceId, phone: values.phone, consent: values.consent === 'on' };
  // Retain the same key on network failures, so pressing send again cannot blindly duplicate it.
  const fingerprint = JSON.stringify(payload);
  if (!pendingRequest || pendingRequest.fingerprint !== fingerprint) pendingRequest = { fingerprint, idempotency: crypto.randomUUID() };
  $('api-result').textContent = 'Sending… wait for the result. This may take up to 25 seconds.';
  try {
    const result = await api('/v1/otp/request', { method: 'POST', key: values.key, body: payload, idempotency: pendingRequest.idempotency });
    $('verify-id').value = result.requestId;
    $('api-result').textContent = JSON.stringify(result, null, 2);
    if (!['sending', 'delivery_unknown'].includes(result.delivery)) pendingRequest = null;
    notify(result.delivery === 'delivery_unknown' ? 'Delivery is uncertain. Check status; do not blindly resend.' : 'Request recorded. Check the recipient’s WhatsApp.');
  } catch (err) {
    $('api-result').textContent = `${err.message}\nThe same request will reuse its idempotency key on retry.`;
    throw err;
  } finally { await refresh(); }
});
bindForm('verify-form', async (values, form) => {
  const result = await api('/v1/otp/verify', { method: 'POST', key: $('playground-key').value, body: values });
  $('api-result').textContent = JSON.stringify(result, null, 2); form.elements.code.value = ''; notify('OTP verified and consumed.'); await refresh();
});
$('request-status').addEventListener('click', async () => {
  const id = $('verify-id').value;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notify('Enter a request ID first.', true);
  try { $('api-result').textContent = JSON.stringify(await api(`/v1/otp/${id}`, { key: $('playground-key').value }), null, 2); }
  catch (err) { notify(err.message, true); }
});
$('curl-example').textContent = `# Run on your application SERVER, not in a public frontend.\n# Populate OTP_API_KEY and DEVICE_ID using server-side configuration.\ncurl '${location.origin}/v1/otp/request' \\\n  -H "Authorization: Bearer $OTP_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H "Idempotency-Key: $(uuidgen)" \\\n  -d "{\\"deviceId\\":\\"$DEVICE_ID\\",\\"phone\\":\\"+6281234567890\\",\\"consent\\":true}"\n\n# Verify using requestId from the response and the recipient’s code.\ncurl '${location.origin}/v1/otp/verify' \\\n  -H "Authorization: Bearer $OTP_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '{"requestId":"REQUEST_UUID","code":"123456"}'`;
try {
  const state = await api('/api/bootstrap');
  if (state.authenticated) await showWorkspace(); else showAuth(state.setupRequired);
} catch (err) { $('loading').textContent = 'Could not reach the gateway. Check the server and reload.'; notify(err.message, true); }
setInterval(() => { if (!document.hidden && signedIn) refresh().catch(() => {}); }, 5000);
