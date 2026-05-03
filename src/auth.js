// Session-based authentication backed by Cloudflare KV.

import {
  clearCookie,
  error,
  getCookie,
  hashPassword,
  isValidUsername,
  json,
  now,
  setCookie,
  shapeUserPublic,
  uid,
  verifyPassword,
} from './util.js';

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const COOKIE = 'devo_session';

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function createSession(env, userId) {
  const token = uid('s');
  await env.SESSIONS.put(`session:${token}`, userId, {
    expirationTtl: SESSION_TTL,
  });
  return token;
}

export async function getSessionUser(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const userId = await env.SESSIONS.get(`session:${token}`);
  if (!userId) return null;
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first();
  if (!row) return null;
  // Touch last_seen_at so presence stays fresh.
  const ts = now();
  await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?')
    .bind(ts, userId)
    .run();
  row.last_seen_at = ts;
  return row;
}

export async function handleRegister(request, env) {
  const data = await readJson(request);
  if (!data) return error(400, 'invalid_json');

  const username = (data.username || '').trim().toLowerCase();
  const displayName = (data.display_name || data.username || '').trim();
  const password = data.password || '';

  if (!isValidUsername(username)) return error(400, 'invalid_username');
  if (!displayName || displayName.length > 64) return error(400, 'invalid_display_name');
  if (typeof password !== 'string' || password.length < 6 || password.length > 256) {
    return error(400, 'invalid_password');
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (existing) return error(409, 'username_taken');

  const { hash, salt } = await hashPassword(password);
  const id = uid('u');
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, password_salt, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, username, displayName, hash, salt, ts, ts)
    .run();

  const token = await createSession(env, id);
  return json(
    {
      user: shapeUserPublic({
        id,
        username,
        display_name: displayName,
        avatar_key: null,
        bio: null,
        last_seen_at: ts,
      }),
    },
    {
      headers: { 'set-cookie': setCookie(COOKIE, token, { maxAge: SESSION_TTL }) },
    },
  );
}

export async function handleLogin(request, env) {
  const data = await readJson(request);
  if (!data) return error(400, 'invalid_json');
  const username = (data.username || '').trim().toLowerCase();
  const password = data.password || '';
  if (!username || !password) return error(400, 'missing_credentials');

  const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (!row) return error(401, 'invalid_credentials');
  const ok = await verifyPassword(password, row.password_salt, row.password_hash);
  if (!ok) return error(401, 'invalid_credentials');

  const token = await createSession(env, row.id);
  return json(
    { user: shapeUserPublic(row) },
    { headers: { 'set-cookie': setCookie(COOKIE, token, { maxAge: SESSION_TTL }) } },
  );
}

export async function handleLogout(request, env) {
  const token = getCookie(request, COOKIE);
  if (token) await env.SESSIONS.delete(`session:${token}`);
  return json({ ok: true }, { headers: { 'set-cookie': clearCookie(COOKIE) } });
}

export async function handleMe(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return error(401, 'not_authenticated');
  return json({ user: shapeUserPublic(user) });
}

export async function handleUpdateProfile(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return error(401, 'not_authenticated');
  const data = await readJson(request);
  if (!data) return error(400, 'invalid_json');

  const updates = [];
  const args = [];
  if (typeof data.display_name === 'string') {
    const dn = data.display_name.trim();
    if (!dn || dn.length > 64) return error(400, 'invalid_display_name');
    updates.push('display_name = ?');
    args.push(dn);
  }
  if (typeof data.bio === 'string') {
    if (data.bio.length > 280) return error(400, 'invalid_bio');
    updates.push('bio = ?');
    args.push(data.bio);
  }
  if (typeof data.avatar_key === 'string') {
    updates.push('avatar_key = ?');
    args.push(data.avatar_key);
  }
  if (!updates.length) return error(400, 'no_changes');

  args.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...args)
    .run();
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(user.id)
    .first();
  return json({ user: shapeUserPublic(row) });
}
