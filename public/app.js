// DEVO+ frontend — vanilla JS SPA.

const state = {
  me: null,
  chats: [],
  activeChat: null,
  messages: [],
  ws: null,
  typingTimeout: null,
  peerTypingTimeout: null,
  pollInterval: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- API helpers ----------

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
    body: options.body && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- UI helpers ----------

function showScreen(name) {
  $$('.screen').forEach((el) => {
    el.hidden = el.dataset.screen !== name;
  });
}

function showModal(name) {
  $$(`.modal`).forEach((el) => {
    el.hidden = el.dataset.modal !== name;
  });
}

function hideModals() {
  $$('.modal').forEach((el) => (el.hidden = true));
}

function toast(msg, ms = 2200) {
  const el = $('[data-toast]');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

function initial(name) {
  if (!name) return '?';
  return name.trim().charAt(0).toUpperCase();
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtPreview(msg) {
  if (!msg) return '';
  if (msg.deleted_at) return 'сообщение удалено';
  if (msg.kind === 'image') return '📷 Фото';
  if (msg.kind === 'voice') return '🎙 Голосовое';
  if (msg.kind === 'file') return '📎 Файл';
  return (msg.body || '').slice(0, 80);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- Theme ----------

function applyTheme(t) {
  if (t === 'light' || t === 'dark') {
    document.documentElement.setAttribute('data-theme', t);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function loadTheme() {
  const t = localStorage.getItem('devo_theme');
  applyTheme(t);
  return t;
}

function saveTheme(t) {
  if (t) localStorage.setItem('devo_theme', t);
  else localStorage.removeItem('devo_theme');
}

// ---------- Auth flow ----------

async function checkAuth() {
  try {
    const data = await api('auth/me');
    state.me = data.user;
    return true;
  } catch {
    state.me = null;
    return false;
  }
}

function setupAuthScreen() {
  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      const which = tab.dataset.tab;
      $$('[data-form]').forEach((f) => (f.hidden = f.dataset.form !== which));
    }),
  );

  $('[data-form="login"]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = e.target.querySelector('[data-error]');
    errEl.hidden = true;
    try {
      const data = await api('auth/login', {
        method: 'POST',
        body: { username: fd.get('username'), password: fd.get('password') },
      });
      state.me = data.user;
      await enterApp();
    } catch (err) {
      errEl.textContent = errMessage(err);
      errEl.hidden = false;
    }
  });

  $('[data-form="register"]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = e.target.querySelector('[data-error]');
    errEl.hidden = true;
    try {
      const data = await api('auth/register', {
        method: 'POST',
        body: {
          display_name: fd.get('display_name'),
          username: fd.get('username'),
          password: fd.get('password'),
        },
      });
      state.me = data.user;
      await enterApp();
    } catch (err) {
      errEl.textContent = errMessage(err);
      errEl.hidden = false;
    }
  });
}

function errMessage(err) {
  const map = {
    invalid_credentials: 'Неверный логин или пароль',
    username_taken: 'Этот логин уже занят',
    invalid_username: 'Логин должен быть 3–32 символа: a-z, 0-9, _',
    invalid_password: 'Пароль должен быть от 6 символов',
    invalid_display_name: 'Имя должно быть 1–64 символа',
    not_authenticated: 'Сессия истекла, войдите заново',
    user_not_found: 'Пользователь не найден',
    cannot_message_self: 'Нельзя написать самому себе',
  };
  return map[err?.message] || err?.message || 'Ошибка';
}

// ---------- Chat list ----------

async function loadChats() {
  const data = await api('chats');
  state.chats = data.chats;
  renderChatList();
}

function renderChatList(filter = '') {
  const list = $('[data-chat-list]');
  list.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const items = state.chats.filter((c) =>
    !q || (c.title || '').toLowerCase().includes(q) ||
    (c.peer?.username || '').toLowerCase().includes(q) ||
    (c.last_message?.body || '').toLowerCase().includes(q),
  );

  if (!items.length) {
    list.innerHTML = `<div class="empty"><p>${
      q ? 'Ничего не найдено' : 'Нет чатов. Нажмите «+», чтобы написать кому-нибудь.'
    }</p></div>`;
    return;
  }

  for (const chat of items) {
    const tile = document.createElement('button');
    tile.className = 'chat-tile';
    tile.type = 'button';
    tile.dataset.chatId = chat.id;
    const time = chat.last_message?.created_at
      ? fmtTime(chat.last_message.created_at)
      : '';
    tile.innerHTML = `
      <div class="avatar">${escapeHtml(initial(chat.title))}</div>
      <div class="tile-body">
        <div class="tile-top">
          <div class="tile-name">${escapeHtml(chat.title || 'Чат')}</div>
          <div class="tile-time">${time}</div>
        </div>
        <div class="tile-preview">${escapeHtml(fmtPreview(chat.last_message))}</div>
      </div>
    `;
    tile.addEventListener('click', () => openChat(chat.id));
    list.appendChild(tile);
  }
}

// ---------- Open chat ----------

async function openChat(chatId) {
  const data = await api(`chats/${chatId}`);
  state.activeChat = data.chat;
  $('[data-chat-title]').textContent = data.chat.title || 'Чат';
  $('[data-chat-sub]').textContent =
    data.chat.type === 'group'
      ? `${data.chat.members.length} участников`
      : presenceText(data.chat.peer);
  $('[data-chat-avatar]').textContent = initial(data.chat.title);

  showScreen('chat');
  await loadMessages();
  connectWebSocket(chatId);
  $('[data-input]').focus();
}

function presenceText(peer) {
  if (!peer?.last_seen_at) return '';
  const diff = Date.now() - peer.last_seen_at;
  if (diff < 60_000) return 'в сети';
  if (diff < 3_600_000) return `был ${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `был ${Math.floor(diff / 3_600_000)} ч назад`;
  return `был ${new Date(peer.last_seen_at).toLocaleDateString()}`;
}

async function loadMessages() {
  const data = await api(`chats/${state.activeChat.id}/messages?limit=100`);
  state.messages = data.messages;
  renderMessages();
}

function renderMessages() {
  const el = $('[data-messages]');
  el.innerHTML = '';
  let lastDay = null;
  for (const msg of state.messages) {
    const day = new Date(msg.created_at).toDateString();
    if (day !== lastDay) {
      const div = document.createElement('div');
      div.className = 'day-divider';
      div.textContent = formatDay(msg.created_at);
      el.appendChild(div);
      lastDay = day;
    }
    el.appendChild(renderMessage(msg));
  }
  el.scrollTop = el.scrollHeight;

  // Mark last message as read.
  const last = state.messages[state.messages.length - 1];
  if (last && last.sender_id !== state.me.id) {
    api(`chats/${state.activeChat.id}/read`, {
      method: 'POST',
      body: { message_id: last.id },
    }).catch(() => {});
  }
}

function formatDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  const y = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
}

function renderMessage(msg) {
  const div = document.createElement('div');
  div.className = 'message' + (msg.sender_id === state.me.id ? ' is-mine' : '');
  div.dataset.id = msg.id;

  let body = '';
  if (msg.deleted_at) {
    body = '<em style="opacity:.6">Сообщение удалено</em>';
  } else if (msg.body) {
    body = escapeHtml(msg.body);
  }

  let attach = '';
  if (msg.attachment_key && !msg.deleted_at) {
    const url = `/media/${encodeURIComponent(msg.attachment_key)}`;
    if (msg.kind === 'image') {
      attach = `<a class="message__attach" href="${url}" target="_blank" rel="noopener">
        <img loading="lazy" src="${url}" alt="" />
      </a>`;
    } else if (msg.kind === 'voice') {
      attach = `<div class="message__attach"><audio controls preload="none" src="${url}"></audio></div>`;
    } else {
      const name = msg.attachment_meta?.name || 'файл';
      attach = `<a class="message__file" href="${url}" target="_blank" rel="noopener">
        📎 ${escapeHtml(name)}
      </a>`;
    }
  }

  div.innerHTML = `${body}${attach}<span class="message__time">${fmtTime(msg.created_at)}</span>`;
  return div;
}

// ---------- WebSocket ----------

function connectWebSocket(chatId) {
  if (state.ws) {
    try { state.ws.close(); } catch { /* ignore */ }
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(chatId)}`);
  state.ws = ws;

  ws.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    handleWsEvent(data);
  });
  ws.addEventListener('close', () => {
    if (state.ws === ws) state.ws = null;
  });
}

function handleWsEvent(ev) {
  if (ev.type === 'message') {
    state.messages.push(ev.message);
    renderMessages();
    refreshChatPreview(ev.message);
  } else if (ev.type === 'message_deleted') {
    const m = state.messages.find((x) => x.id === ev.message_id);
    if (m) {
      m.deleted_at = Date.now();
      renderMessages();
    }
  } else if (ev.type === 'typing') {
    if (state.activeChat?.type === 'direct' && ev.user_id !== state.me.id) {
      const t = $('[data-typing]');
      t.hidden = false;
      clearTimeout(state.peerTypingTimeout);
      state.peerTypingTimeout = setTimeout(() => (t.hidden = true), 2500);
    }
  } else if (ev.type === 'read') {
    // Could be visualised with check marks; left as a future hook.
  } else if (ev.type === 'presence') {
    if (state.activeChat?.peer?.id === ev.user_id) {
      $('[data-chat-sub]').textContent = ev.online ? 'в сети' : 'не в сети';
    }
  }
}

function refreshChatPreview(msg) {
  const c = state.chats.find((x) => x.id === msg.chat_id);
  if (c) {
    c.last_message = msg;
    c.updated_at = msg.created_at;
    state.chats.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    renderChatList($('[data-search]').value);
  } else {
    loadChats().catch(() => {});
  }
}

// ---------- Composer ----------

function setupComposer() {
  const form = $('[data-composer]');
  const input = $('[data-input]');
  const fileInput = $('[data-file]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await sendText();
  });

  $('[data-send]').addEventListener('click', sendText);

  input.addEventListener('input', () => {
    if (state.ws?.readyState === WebSocket.OPEN && !state.typingTimeout) {
      state.ws.send(JSON.stringify({ type: 'typing' }));
      state.typingTimeout = setTimeout(() => {
        state.typingTimeout = null;
      }, 1500);
    }
  });

  $('[data-attach]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';
    await sendFile(file);
  });

  $('[data-mic]').addEventListener('click', toggleVoiceRecording);
  $('[data-back]').addEventListener('click', leaveChat);
}

async function sendText() {
  const input = $('[data-input]');
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  try {
    await api(`chats/${state.activeChat.id}/messages`, {
      method: 'POST',
      body: { body, kind: 'text' },
    });
  } catch (err) {
    toast(errMessage(err));
  }
}

async function sendFile(file) {
  toast('Загружаю...');
  try {
    const res = await fetch('/api/media', {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || 'upload_failed');
    }
    const data = await res.json();
    let kind = 'file';
    if ((file.type || '').startsWith('image/')) kind = 'image';
    else if ((file.type || '').startsWith('audio/')) kind = 'voice';
    await api(`chats/${state.activeChat.id}/messages`, {
      method: 'POST',
      body: {
        kind,
        attachment_key: data.key,
        attachment_meta: { name: file.name, size: data.size, type: data.content_type },
        body: '',
      },
    });
  } catch (err) {
    toast(errMessage(err));
  }
}

let mediaRecorder = null;
let recordedChunks = [];

async function toggleVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Микрофон не поддерживается');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordedChunks, { type: mime || 'audio/webm' });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
      await sendFile(file);
      mediaRecorder = null;
    };
    mediaRecorder.start();
    toast('Запись... нажмите ещё раз чтобы отправить');
  } catch (err) {
    toast('Не удалось получить доступ к микрофону');
  }
}

function leaveChat() {
  if (state.ws) {
    try { state.ws.close(); } catch { /* ignore */ }
    state.ws = null;
  }
  state.activeChat = null;
  state.messages = [];
  showScreen('chats');
  loadChats().catch(() => {});
}

// ---------- New chat / search ----------

function setupNewChat() {
  $('[data-new-chat]').addEventListener('click', () => {
    $('[data-user-search]').value = '';
    $('[data-user-results]').innerHTML = '';
    showModal('new-chat');
    setTimeout(() => $('[data-user-search]').focus(), 100);
  });
  $('[data-user-search]').addEventListener('input', debounce(searchUsers, 250));
}

async function searchUsers() {
  const q = $('[data-user-search]').value.trim();
  if (!q) {
    $('[data-user-results]').innerHTML = '';
    return;
  }
  try {
    const data = await api(`users/search?q=${encodeURIComponent(q)}`);
    const list = $('[data-user-results]');
    list.innerHTML = '';
    if (!data.users.length) {
      list.innerHTML = '<div class="empty"><p>Никого не найдено</p></div>';
      return;
    }
    for (const u of data.users) {
      const item = document.createElement('button');
      item.className = 'user-result';
      item.type = 'button';
      item.innerHTML = `
        <div class="avatar" style="width:40px;height:40px;font-size:14px">${escapeHtml(initial(u.display_name))}</div>
        <div>
          <div class="user-result__name">${escapeHtml(u.display_name)}</div>
          <div class="user-result__sub">@${escapeHtml(u.username)}</div>
        </div>
      `;
      item.addEventListener('click', async () => {
        try {
          const r = await api('chats', {
            method: 'POST',
            body: { type: 'direct', username: u.username },
          });
          hideModals();
          await loadChats();
          openChat(r.chat_id);
        } catch (err) {
          toast(errMessage(err));
        }
      });
      list.appendChild(item);
    }
  } catch (err) {
    toast(errMessage(err));
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Profile ----------

function setupProfile() {
  $('[data-menu]').addEventListener('click', () => {
    const f = $('[data-profile-form]');
    f.elements.display_name.value = state.me?.display_name || '';
    f.elements.bio.value = state.me?.bio || '';
    $('[data-theme-toggle]').checked =
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      (loadTheme() === null && matchMedia('(prefers-color-scheme: dark)').matches);
    showModal('profile');
  });

  $('[data-profile-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('me', {
        method: 'PATCH',
        body: { display_name: fd.get('display_name'), bio: fd.get('bio') },
      });
      state.me = r.user;
      hideModals();
      toast('Сохранено');
    } catch (err) {
      toast(errMessage(err));
    }
  });

  $('[data-theme-toggle]').addEventListener('change', (e) => {
    const t = e.target.checked ? 'dark' : 'light';
    applyTheme(t);
    saveTheme(t);
  });

  $('[data-logout]').addEventListener('click', async () => {
    await api('auth/logout', { method: 'POST' }).catch(() => {});
    if (state.pollInterval) {
      clearInterval(state.pollInterval);
      state.pollInterval = null;
    }
    state.me = null;
    state.chats = [];
    hideModals();
    showScreen('auth');
  });
}

function setupModals() {
  $$('[data-close]').forEach((el) => el.addEventListener('click', hideModals));
}

function setupSearch() {
  $('[data-search]').addEventListener('input', (e) => {
    renderChatList(e.target.value);
  });
}

// ---------- Boot ----------

async function enterApp() {
  showScreen('chats');
  await loadChats();
  // Lightweight polling fallback for chat list updates when no chat is open.
  if (state.pollInterval) clearInterval(state.pollInterval);
  state.pollInterval = setInterval(() => {
    if (!state.activeChat && state.me) loadChats().catch(() => {});
  }, 15_000);
}

async function boot() {
  loadTheme();
  setupAuthScreen();
  setupComposer();
  setupNewChat();
  setupProfile();
  setupModals();
  setupSearch();

  if (await checkAuth()) {
    await enterApp();
  } else {
    showScreen('auth');
  }
}

boot();
