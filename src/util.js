// Small helpers used across the worker.

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export function error(status, message, extra = {}) {
  return json({ error: message, ...extra }, { status });
}

export function uid(prefix = '') {
  // 16 bytes of randomness, base32-ish.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return prefix ? `${prefix}_${s}` : s;
}

export function now() {
  return Date.now();
}

const enc = new TextEncoder();

function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// PBKDF2-style password hashing using HMAC-SHA-256 (Workers-friendly,
// no Node crypto required).
export async function hashPassword(password, saltHex) {
  let salt = saltHex;
  if (!salt) {
    const buf = crypto.getRandomValues(new Uint8Array(16));
    salt = toHex(buf);
  }
  const iterations = 100_000;
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    256,
  );
  return { hash: toHex(new Uint8Array(bits)), salt };
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  const { hash } = await hashPassword(password, saltHex);
  // Constant-time comparison.
  if (hash.length !== expectedHashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ expectedHashHex.charCodeAt(i);
  }
  return diff === 0;
}

export function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function setCookie(name, value, opts = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    `Max-Age=${opts.maxAge ?? 60 * 60 * 24 * 30}`,
    'HttpOnly',
    'Secure',
    `SameSite=${opts.sameSite ?? 'Lax'}`,
  ];
  return parts.join('; ');
}

export function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

export function isValidUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

export function shapeUserPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    avatar_key: row.avatar_key,
    bio: row.bio,
    last_seen_at: row.last_seen_at,
  };
}

export function shapeMessage(row) {
  if (!row) return null;
  let meta = null;
  if (row.attachment_meta) {
    try { meta = JSON.parse(row.attachment_meta); } catch { meta = null; }
  }
  return {
    id: row.id,
    chat_id: row.chat_id,
    sender_id: row.sender_id,
    body: row.body,
    kind: row.kind,
    attachment_key: row.attachment_key,
    attachment_meta: meta,
    reply_to_id: row.reply_to_id,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
  };
}
