'use strict';

(() => {
  const root = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const overlay = document.getElementById('drop-overlay');

  const state = {
    files: [],
    storage: null,
    maxUploadBytes: 500 * 1024 * 1024,
    publicUrl: null,
    settings: null,
    uploads: [],
    newIds: new Set(),
    query: '',
    replaceTarget: null,
    pendingMethod: null,
  };

  let refs = null; // set while the signed-in app is on screen
  const rows = new Map(); // file id -> <li>
  const rowRefs = new WeakMap();

  // ── Helpers ──────────────────────────────────────────────────────────

  const refsOf = (node) => {
    const out = {};
    node.querySelectorAll('[data-ref]').forEach((el) => {
      out[el.dataset.ref] = el;
    });
    return out;
  };

  const cloneTemplate = (id) =>
    document.getElementById(id).content.firstElementChild.cloneNode(true);

  async function api(method, url, body) {
    const headers = { 'X-Fyle': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Empty or non-JSON body.
    }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status}).`);
      err.status = res.status;
      if (res.status === 401 && refs) showLogin();
      throw err;
    }
    return data;
  }

  function formatBytes(bytes) {
    if (bytes == null) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    const digits = i === 0 || value >= 100 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[i]}`;
  }

  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function timeAgo(ts) {
    const seconds = (Date.now() - ts) / 1000;
    if (seconds < 45) return 'just now';
    const steps = [
      ['minute', 60],
      ['hour', 3600],
      ['day', 86400],
      ['week', 604800],
      ['month', 2629800],
      ['year', 31557600],
    ];
    let [unit, size] = steps[0];
    for (const [u, s] of steps) if (seconds >= s) [unit, size] = [u, s];
    return relative.format(-Math.round(seconds / size), unit);
  }

  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const linkBase = () => state.publicUrl || location.origin;
  const hostLabel = () => `${linkBase().replace(/^https?:\/\//, '')}/`;
  const linkFor = (file) => `${linkBase()}/${file.slug}`;

  function extensionOf(name) {
    const match = /\.([a-z0-9]{1,5})$/i.exec(name);
    return match ? match[1].toUpperCase() : 'FILE';
  }

  let toastTimer;
  function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', isError);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), isError ? 5000 : 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // navigator.clipboard is unavailable over plain http; fall back.
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'offscreen';
      document.body.append(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  const passkeysSupported = () =>
    window.isSecureContext && 'PublicKeyCredential' in window && 'SimpleWebAuthnBrowser' in window;

  function passkeyError(err) {
    switch (err?.name) {
      case 'NotAllowedError':
      case 'AbortError':
        return 'The passkey prompt was closed or timed out.';
      case 'InvalidStateError':
        return 'That passkey is already saved.';
      case 'SecurityError':
        return 'Passkeys need HTTPS and the same domain they were added on.';
      default:
        return err?.message || 'Something went wrong with the passkey.';
    }
  }

  // ── Sign in ──────────────────────────────────────────────────────────

  async function showLogin(known) {
    refs = null;
    rows.clear();
    const session =
      known ?? (await api('GET', '/api/session').catch(() => ({ method: 'password' })));
    const node = cloneTemplate('tpl-login');
    const r = refsOf(node);
    root.replaceChildren(node);
    document.title = 'Sign in · Fyle';

    const preferred =
      session.method === 'passkey' && !passkeysSupported() ? 'password' : session.method;
    let mode;

    const ledes = {
      password: 'Enter the admin password to open your files.',
      pin: 'Enter your PIN to open your files.',
      passkey: 'Use your passkey to open your files.',
    };
    const switchLabels = {
      pin: 'Use PIN instead',
      passkey: 'Use passkey instead',
    };

    function setMode(next) {
      mode = next;
      r['password-form'].hidden = mode !== 'password';
      r['pin-form'].hidden = mode !== 'pin';
      r['passkey-box'].hidden = mode !== 'passkey';
      r.lede.textContent = ledes[mode];
      r.error.textContent = '';
      if (session.method === 'passkey' && !passkeysSupported()) {
        r.error.textContent = 'This browser can’t use passkeys here, so use the admin password.';
      }
      if (mode !== 'password') {
        r.switch.textContent = 'Use admin password instead';
        r.switch.hidden = false;
      } else if (preferred !== 'password') {
        r.switch.textContent = switchLabels[preferred];
        r.switch.hidden = false;
      } else {
        r.switch.hidden = true;
      }
      requestAnimationFrame(() => {
        if (mode === 'password') r['password-form'].elements.password.focus();
        if (mode === 'pin') pinInput.focus();
      });
    }

    r.switch.addEventListener('click', () => setMode(mode === 'password' ? preferred : 'password'));

    const done = () => showApp();

    // Password
    r['password-form'].addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      button.disabled = true;
      r.error.textContent = '';
      try {
        await api('POST', '/api/login/password', { password: form.elements.password.value });
        done();
      } catch (err) {
        r.error.textContent = err.message;
        form.elements.password.select();
      } finally {
        button.disabled = false;
      }
    });

    // PIN — fills boxes as you type and submits on the last digit.
    const pinLength = session.pinLength || 6;
    const pinInput = r.pin.querySelector('input');
    pinInput.maxLength = pinLength;
    const boxes = Array.from({ length: pinLength }, () => document.createElement('span'));
    r['pin-boxes'].replaceChildren(...boxes);
    let pinBusy = false;

    function paintPin() {
      const value = pinInput.value;
      boxes.forEach((box, i) => {
        box.classList.toggle('filled', i < value.length);
        box.classList.toggle('active', i === Math.min(value.length, pinLength - 1));
      });
    }

    async function submitPin() {
      if (pinBusy) return;
      pinBusy = true;
      r.error.textContent = '';
      try {
        await api('POST', '/api/login/pin', { pin: pinInput.value });
        done();
      } catch (err) {
        r.error.textContent = err.message;
        r.pin.classList.add('error', 'shake');
        setTimeout(() => r.pin.classList.remove('shake'), 350);
        pinInput.value = '';
        paintPin();
        pinInput.focus();
      } finally {
        pinBusy = false;
      }
    }

    pinInput.addEventListener('input', () => {
      pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, pinLength);
      r.pin.classList.remove('error');
      paintPin();
      if (pinInput.value.length === pinLength) submitPin();
    });
    pinInput.addEventListener('focus', paintPin);
    r['pin-form'].addEventListener('submit', (event) => {
      event.preventDefault();
      if (pinInput.value.length >= 4) submitPin();
    });
    paintPin();

    // Passkey
    r['passkey-btn'].addEventListener('click', async () => {
      r['passkey-btn'].disabled = true;
      r.error.textContent = '';
      try {
        const { challengeId, options } = await api('POST', '/api/login/passkey/options', {});
        const response = await window.SimpleWebAuthnBrowser.startAuthentication({
          optionsJSON: options,
        });
        await api('POST', '/api/login/passkey/verify', { challengeId, response });
        done();
      } catch (err) {
        r.error.textContent = passkeyError(err);
      } finally {
        r['passkey-btn'].disabled = false;
      }
    });

    setMode(preferred);
  }

  // ── App shell ────────────────────────────────────────────────────────

  async function showApp() {
    const fragment = document.getElementById('tpl-app').content.cloneNode(true);
    refs = refsOf(fragment);
    rows.clear();
    root.replaceChildren(fragment);

    refs.logout.addEventListener('click', async () => {
      await api('POST', '/api/logout', {}).catch(() => {});
      showLogin();
    });

    // Upload entry points
    refs.dropzone.addEventListener('click', () => refs.picker.click());
    refs.dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        refs.picker.click();
      }
    });
    refs.picker.addEventListener('click', (event) => event.stopPropagation());
    refs.picker.addEventListener('change', () => {
      enqueue(refs.picker.files);
      refs.picker.value = '';
    });
    refs['replace-picker'].addEventListener('change', () => {
      const [file] = refs['replace-picker'].files;
      if (file && state.replaceTarget) enqueue([file], state.replaceTarget);
      state.replaceTarget = null;
      refs['replace-picker'].value = '';
    });

    refs.search.addEventListener('input', () => {
      state.query = refs.search.value;
      renderFiles();
    });

    refs.files.addEventListener('click', onFileAction);
    refs.files.addEventListener('submit', onEditSubmit);
    refs.files.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const row = event.target.closest('.file.editing');
        if (row) closeEdit(row);
      }
    });
    refs.uploads.addEventListener('click', onUploadAction);

    wireSettings();
    renderUploads();
    route();
    await loadFiles().catch((err) => toast(err.message, true));
  }

  function route() {
    if (!refs) return;
    const view = location.hash === '#/settings' ? 'settings' : 'files';
    root.querySelectorAll('[data-view]').forEach((el) => {
      el.hidden = el.dataset.view !== view;
    });
    root.querySelectorAll('[data-nav]').forEach((el) => {
      if (el.dataset.nav === view) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    document.title = view === 'settings' ? 'Settings · Fyle' : 'Fyle';
    if (view === 'settings') loadSettings();
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', route);

  // ── Files ────────────────────────────────────────────────────────────

  async function loadFiles() {
    const data = await api('GET', '/api/files');
    state.files = data.files;
    state.storage = data.storage;
    state.maxUploadBytes = data.maxUploadBytes;
    state.publicUrl = data.publicUrl;
    renderFiles();
  }

  function renderSummary() {
    const { storage } = state;
    refs.count.textContent = plural(state.files.length, 'file');
    const parts = [];
    if (storage) {
      parts.push(`${formatBytes(storage.used)} used`);
      if (storage.free != null) parts.push(`${formatBytes(storage.free)} free`);
    }
    refs.storage.textContent = parts.length ? `· ${parts.join(' · ')}` : '';
    refs.limit.textContent = `Up to ${formatBytes(state.maxUploadBytes)} per file`;
    refs['example-url'].textContent = `${linkBase()}/k7m2qp`;
  }

  function renderFiles() {
    if (!refs) return;
    renderSummary();
    const query = state.query.trim().toLowerCase();
    const visible = query
      ? state.files.filter((f) => f.name.toLowerCase().includes(query) || f.slug.includes(query))
      : state.files;

    const list = refs.files;
    visible.forEach((file, i) => {
      let row = rows.get(file.id);
      if (!row) {
        row = cloneTemplate('tpl-file');
        row.dataset.id = file.id;
        rowRefs.set(row, refsOf(row));
        rows.set(file.id, row);
      }
      paintRow(row, file);
      if (list.children[i] !== row) list.insertBefore(row, list.children[i] ?? null);
    });
    while (list.children.length > visible.length) list.lastElementChild.remove();
    for (const id of rows.keys()) {
      if (!state.files.some((f) => f.id === id)) rows.delete(id);
    }

    refs.empty.hidden = state.files.length > 0;
    refs['no-match'].hidden = state.files.length === 0 || visible.length > 0;
  }

  function paintRow(row, file) {
    const r = rowRefs.get(row);
    r.ext.textContent = extensionOf(file.name);
    r.name.textContent = file.name;
    r.name.title = file.name;
    r.meta.textContent = [
      formatBytes(file.size),
      timeAgo(file.createdAt),
      plural(file.downloads, 'download'),
    ].join(' · ');
    const slug = document.createElement('b');
    slug.textContent = file.slug;
    r.link.replaceChildren(document.createTextNode(hostLabel()), slug);
    r.link.title = `${linkFor(file)} — click to copy`;
    row.classList.toggle('is-new', state.newIds.has(file.id));
  }

  const fileById = (id) => state.files.find((f) => f.id === id);

  async function onFileAction(event) {
    const button = event.target.closest('[data-action]');
    const row = event.target.closest('.file');
    if (!button || !row) return;
    const file = fileById(row.dataset.id);
    if (!file) return;

    switch (button.dataset.action) {
      case 'copy': {
        const ok = await copyText(linkFor(file));
        if (!ok) return toast('Couldn’t copy — select the link and copy it manually.', true);
        const copyBtn = row.querySelector('.copy-btn');
        copyBtn.classList.add('copied');
        copyBtn.querySelector('use').setAttribute('href', '#i-check');
        copyBtn.querySelector('span').textContent = 'Copied';
        clearTimeout(copyBtn._timer);
        copyBtn._timer = setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.querySelector('use').setAttribute('href', '#i-copy');
          copyBtn.querySelector('span').textContent = 'Copy link';
        }, 1600);
        toast('Link copied');
        break;
      }
      case 'edit':
        if (row.classList.contains('editing')) closeEdit(row);
        else openEdit(row, file);
        break;
      case 'cancel':
        closeEdit(row);
        break;
      case 'replace':
        state.replaceTarget = file.id;
        refs['replace-picker'].click();
        break;
      case 'delete':
        if (!button.classList.contains('confirming')) {
          button.classList.add('confirming');
          clearTimeout(button._timer);
          button._timer = setTimeout(() => button.classList.remove('confirming'), 3000);
          return;
        }
        button.disabled = true;
        try {
          await api('DELETE', `/api/files/${file.id}`);
          state.files = state.files.filter((f) => f.id !== file.id);
          if (state.storage) state.storage.used -= file.size;
          renderFiles();
          toast(`Deleted ${file.name}`);
        } catch (err) {
          toast(err.message, true);
          button.disabled = false;
        }
        break;
    }
  }

  function openEdit(row, file) {
    const r = rowRefs.get(row);
    row.classList.add('editing');
    r.edit.hidden = false;
    r.host.textContent = hostLabel();
    r.edit.elements.slug.value = file.slug;
    r.edit.elements.name.value = file.name;
    r['edit-error'].textContent = '';
    r.edit.elements.slug.focus();
    r.edit.elements.slug.select();
  }

  function closeEdit(row) {
    const r = rowRefs.get(row);
    row.classList.remove('editing');
    r.edit.hidden = true;
  }

  async function onEditSubmit(event) {
    event.preventDefault();
    const row = event.target.closest('.file');
    const file = row && fileById(row.dataset.id);
    if (!file) return;
    const r = rowRefs.get(row);
    const slug = r.edit.elements.slug.value.trim().toLowerCase();
    const name = r.edit.elements.name.value.trim();
    const changes = {};
    if (slug !== file.slug) changes.slug = slug;
    if (name !== file.name) changes.name = name;
    if (!Object.keys(changes).length) return closeEdit(row);

    const submit = r.edit.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const updated = await api('PATCH', `/api/files/${file.id}`, changes);
      Object.assign(file, updated);
      closeEdit(row);
      renderFiles();
      toast(changes.slug ? `Link changed to ${hostLabel()}${updated.slug}` : 'Saved');
    } catch (err) {
      r['edit-error'].textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  }

  // ── Uploads ──────────────────────────────────────────────────────────

  const MAX_PARALLEL = 2;
  let running = 0;
  let uploadKey = 0;

  function enqueue(fileList, replaceId = null) {
    if (!refs) return;
    if (location.hash === '#/settings') location.hash = '#/';
    for (const file of fileList) {
      const item = {
        key: ++uploadKey,
        file,
        name: file.name,
        size: file.size,
        loaded: 0,
        status: 'queued',
        replaceId,
        error: null,
        xhr: null,
        el: null,
      };
      if (file.size > state.maxUploadBytes) {
        item.status = 'failed';
        item.error = `Too big — the limit is ${formatBytes(state.maxUploadBytes)}.`;
      }
      state.uploads.push(item);
    }
    renderUploads();
    pump();
  }

  function pump() {
    while (running < MAX_PARALLEL) {
      const next = state.uploads.find((u) => u.status === 'queued');
      if (!next) break;
      start(next);
    }
  }

  function start(item) {
    running += 1;
    item.status = 'uploading';
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    const url = item.replaceId ? `/api/files/${item.replaceId}/content` : '/api/files';
    xhr.open(item.replaceId ? 'PUT' : 'POST', url);
    xhr.setRequestHeader('X-Fyle', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.name));

    let frame = 0;
    xhr.upload.addEventListener('progress', (event) => {
      item.loaded = event.loaded;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          paintUpload(item);
        });
      }
    });

    const finish = () => {
      running -= 1;
      pump();
    };

    xhr.addEventListener('load', () => {
      finish();
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON error page from a proxy, most likely.
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) return uploaded(item, data);
      if (xhr.status === 401) return showLogin();
      let message = data?.error || `Upload failed (HTTP ${xhr.status}).`;
      if (xhr.status === 413 && !data) {
        message = 'Rejected by a proxy in front of Fyle — raise its upload size limit.';
      }
      failed(item, message);
    });
    xhr.addEventListener('error', () => {
      finish();
      failed(item, 'Connection lost. Check your network (or a proxy’s upload limit) and retry.');
    });
    xhr.addEventListener('abort', () => {
      finish();
      removeUpload(item);
    });

    xhr.send(item.file);
    paintUpload(item);
  }

  function uploaded(item, file) {
    removeUpload(item);
    const index = state.files.findIndex((f) => f.id === file.id);
    const previousSize = index >= 0 ? state.files[index].size : 0;
    if (index >= 0) state.files[index] = file;
    else state.files.unshift(file);
    if (state.storage) state.storage.used += file.size - previousSize;
    state.newIds.add(file.id);
    renderFiles();
    toast(item.replaceId ? `Replaced — same link, new file` : `Uploaded ${file.name}`);
    if (!state.uploads.some((u) => u.status === 'uploading' || u.status === 'queued')) {
      loadFiles().catch(() => {});
    }
  }

  function failed(item, message) {
    item.status = 'failed';
    item.error = message;
    paintUpload(item);
  }

  function removeUpload(item) {
    state.uploads = state.uploads.filter((u) => u !== item);
    item.el?.remove();
  }

  function onUploadAction(event) {
    const button = event.target.closest('[data-action="dismiss"]');
    if (!button) return;
    const item = state.uploads.find((u) => u.el === button.closest('.upload'));
    if (!item) return;
    if (item.status === 'uploading') item.xhr.abort();
    else removeUpload(item);
  }

  function renderUploads() {
    if (!refs) return;
    for (const item of state.uploads) {
      if (!item.el) {
        item.el = cloneTemplate('tpl-upload');
        rowRefs.set(item.el, refsOf(item.el));
      }
      if (item.el.parentNode !== refs.uploads) refs.uploads.append(item.el);
      paintUpload(item);
    }
  }

  const PILLS = {
    queued: ['Queued', 'pill-queued'],
    uploading: ['Uploading', 'pill-uploading'],
    failed: ['Failed', 'pill-failed'],
  };

  function paintUpload(item) {
    if (!item.el) return;
    const r = rowRefs.get(item.el);
    const [label, cls] = PILLS[item.status];
    r.pill.textContent = label;
    r.pill.className = `pill ${cls}`;
    r.name.textContent = item.replaceId ? `Replacing with ${item.name}` : item.name;
    r.name.title = item.name;
    item.el.classList.toggle('failed', item.status === 'failed');
    const dismiss = item.el.querySelector('[data-action="dismiss"]');
    dismiss.setAttribute('aria-label', item.status === 'failed' ? 'Dismiss' : 'Cancel upload');
    dismiss.title = dismiss.getAttribute('aria-label');

    const fraction = item.size ? item.loaded / item.size : 1;
    item.el.querySelector('.progress > span').style.setProperty('--progress', String(fraction));

    if (item.status === 'failed') r.meta.textContent = item.error;
    else if (item.status === 'queued') r.meta.textContent = `Waiting · ${formatBytes(item.size)}`;
    else if (fraction >= 1) r.meta.textContent = `Finishing · ${formatBytes(item.size)}`;
    else {
      r.meta.textContent = `${Math.floor(fraction * 100)}% · ${formatBytes(item.loaded)} of ${formatBytes(item.size)}`;
    }
  }

  window.addEventListener('beforeunload', (event) => {
    if (running > 0) event.preventDefault();
  });

  // Drag files anywhere onto the page.
  let dragDepth = 0;
  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!refs || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!refs || !hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!refs || !hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    if (!refs || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    enqueue(event.dataTransfer.files);
  });

  // Paste a file (e.g. a screenshot) to upload it.
  document.addEventListener('paste', (event) => {
    if (!refs || event.target.closest?.('input, textarea')) return;
    const files = event.clipboardData?.files;
    if (files?.length) {
      event.preventDefault();
      enqueue(files);
    }
  });

  // Keep download counts fresh.
  setInterval(() => {
    if (refs && document.visibilityState === 'visible' && location.hash !== '#/settings') {
      loadFiles().catch(() => {});
    }
  }, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (refs && document.visibilityState === 'visible') loadFiles().catch(() => {});
  });

  // ── Settings ─────────────────────────────────────────────────────────

  const METHOD_NAMES = { password: 'Password', pin: 'PIN', passkey: 'Passkey' };

  function wireSettings() {
    refs.methods.addEventListener('click', (event) => {
      const card = event.target.closest('[data-method]');
      if (card) chooseMethod(card.dataset.method);
    });
    refs.methods.addEventListener('keydown', (event) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(event.key in keys)) return;
      event.preventDefault();
      const cards = [...refs.methods.querySelectorAll('[data-method]')];
      const i = cards.indexOf(document.activeElement);
      cards[(i + keys[event.key] + cards.length) % cards.length].focus();
    });

    refs['pin-setup'].addEventListener('submit', savePin);
    refs['pin-setup'].addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\D/g, '').slice(0, 8);
    });
    confirmable(refs['pin-remove'], 'Remove PIN', async () => {
      state.settings = await api('DELETE', '/api/settings/pin');
      renderSettings();
      toast('PIN removed');
    });

    refs['passkey-add'].addEventListener('click', () => addPasskey(false));
    refs['signout-others'].addEventListener('click', async () => {
      try {
        state.settings = await api('DELETE', '/api/sessions/others');
        renderSettings();
        toast('Other devices signed out');
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  /** Two-click confirmation for destructive text links. */
  function confirmable(button, label, action) {
    button.addEventListener('click', async () => {
      if (!button.dataset.armed) {
        button.dataset.armed = '1';
        button.textContent = 'Click again to confirm';
        setTimeout(() => {
          delete button.dataset.armed;
          button.textContent = label;
        }, 3000);
        return;
      }
      delete button.dataset.armed;
      button.textContent = label;
      button.disabled = true;
      try {
        await action();
      } catch (err) {
        toast(err.message, true);
      } finally {
        button.disabled = false;
      }
    });
  }

  async function loadSettings() {
    try {
      state.settings = await api('GET', '/api/settings');
      renderSettings();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function listItem(title, meta, actionLabel, action) {
    const li = cloneTemplate('tpl-item');
    const r = refsOf(li);
    r.title.textContent = title;
    r.meta.textContent = meta;
    if (action) {
      r.action.hidden = false;
      r.action.textContent = actionLabel;
      confirmable(r.action, actionLabel, action);
    }
    return li;
  }

  function renderSettings() {
    if (!refs || !state.settings) return;
    const s = state.settings;
    const domain = s.passkeyDomain || location.hostname;

    const status = {
      password: 'Always available',
      pin: s.pin.set ? `${s.pin.length} digits` : 'Not set',
      passkey: s.passkeys.length ? plural(s.passkeys.length, 'passkey') : 'None yet',
    };
    refs.methods.querySelectorAll('[data-method]').forEach((card) => {
      const method = card.dataset.method;
      const checked = method === s.method;
      card.setAttribute('aria-checked', String(checked));
      card.tabIndex = checked ? 0 : -1;
      card.querySelector('[data-status]').textContent = checked ? 'In use' : status[method];
    });

    refs['pin-status'].textContent = s.pin.set
      ? `Your PIN is ${s.pin.length} digits. Enter a new one to change it.`
      : 'No PIN yet. Choose 4 to 8 digits.';
    refs['pin-save'].textContent = s.pin.set ? 'Change PIN' : 'Save PIN';
    refs['pin-remove'].hidden = !s.pin.set;

    refs['passkey-status'].textContent = s.passkeys.length
      ? `Passkeys work on ${domain}.`
      : `Add one to sign in with Face ID, Touch ID, Windows Hello or a security key. It will work on ${domain}.`;
    refs.passkeys.replaceChildren(
      ...s.passkeys.map((p) =>
        listItem(
          p.name,
          `Added ${timeAgo(p.createdAt)} · ${p.lastUsedAt ? `last used ${timeAgo(p.lastUsedAt)}` : 'not used yet'}`,
          'Remove',
          async () => {
            state.settings = await api('DELETE', `/api/passkeys/${encodeURIComponent(p.id)}`);
            renderSettings();
            toast('Passkey removed');
          },
        ),
      ),
    );

    let warning = '';
    if (!window.isSecureContext) {
      warning =
        'Passkeys need a secure connection. Open Fyle over HTTPS (or on localhost) to add one.';
    } else if (!passkeysSupported()) {
      warning = 'This browser doesn’t support passkeys.';
    }
    refs['passkey-warning'].textContent = warning;
    refs['passkey-warning'].hidden = !warning;
    refs['passkey-add'].disabled = Boolean(warning);

    refs.sessions.replaceChildren(
      ...s.sessions.map((session) =>
        listItem(
          session.current ? `${session.device} · this device` : session.device,
          `Signed in ${timeAgo(session.createdAt)} · active ${timeAgo(session.lastSeenAt)}`,
        ),
      ),
    );
    refs['signout-others'].disabled = s.sessions.length <= 1;
  }

  async function chooseMethod(method) {
    const s = state.settings;
    if (!s || method === s.method) return;

    if (method === 'pin' && !s.pin.set) {
      state.pendingMethod = 'pin';
      const panel = refs['pin-setup'].closest('.panel');
      panel.classList.add('attention');
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      refs['pin-setup'].elements.pin.focus({ preventScroll: true });
      toast('Choose a PIN — Fyle switches to it once it’s saved.');
      return;
    }
    if (method === 'passkey' && !s.passkeys.length) {
      await addPasskey(true);
      return;
    }

    try {
      state.settings = await api('PUT', '/api/settings/method', { method });
      renderSettings();
      toast(`You’ll sign in with ${METHOD_NAMES[method].toLowerCase()} from now on`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function savePin(event) {
    event.preventDefault();
    const form = refs['pin-setup'];
    const pin = form.elements.pin.value;
    const confirm = form.elements.confirm.value;
    if (!/^\d{4,8}$/.test(pin)) {
      form.elements.pin.focus();
      return toast('A PIN is 4 to 8 digits.', true);
    }
    if (pin !== confirm) {
      form.elements.confirm.focus();
      return toast('The two PINs don’t match.', true);
    }
    const activate = state.pendingMethod === 'pin' || state.settings.method === 'pin';
    try {
      state.settings = await api('PUT', '/api/settings/pin', { pin, activate });
      state.pendingMethod = null;
      form.reset();
      form.closest('.panel').classList.remove('attention');
      renderSettings();
      toast(
        state.settings.method === 'pin'
          ? 'PIN saved — you’ll use it next time you sign in'
          : 'PIN saved. Select PIN above to use it.',
      );
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function addPasskey(activate) {
    if (!passkeysSupported()) {
      return toast(
        window.isSecureContext
          ? 'This browser doesn’t support passkeys.'
          : 'Passkeys need HTTPS (or localhost).',
        true,
      );
    }
    refs['passkey-add'].disabled = true;
    try {
      const { challengeId, options } = await api('POST', '/api/passkeys/options', {});
      const response = await window.SimpleWebAuthnBrowser.startRegistration({
        optionsJSON: options,
      });
      state.settings = await api('POST', '/api/passkeys', { challengeId, response, activate });
      renderSettings();
      toast(activate ? 'Passkey added — you’ll use it next time you sign in' : 'Passkey added');
    } catch (err) {
      toast(passkeyError(err), true);
    } finally {
      refs['passkey-add'].disabled = false;
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────

  api('GET', '/api/session')
    .then((session) => (session.authenticated ? showApp() : showLogin(session)))
    .catch(() => {
      root.textContent = 'Couldn’t reach the Fyle server. Refresh to try again.';
    });
})();
