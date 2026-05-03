// Chat / group / message HTTP endpoints. Real-time fan-out lives in
// the ChatRoom Durable Object.

import { error, json, now, shapeMessage, shapeUserPublic, uid } from './util.js';
import { getSessionUser } from './auth.js';

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function fanout(env, chatId, payload) {
  const id = env.CHAT_ROOM.idFromName(chatId);
  const stub = env.CHAT_ROOM.get(id);
  await stub.fetch(`https://chat-room/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function ensureMember(env, chatId, userId) {
  const m = await env.DB.prepare(
    'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?',
  )
    .bind(chatId, userId)
    .first();
  return m;
}

async function findOrCreateDirectChat(env, a, b) {
  // Fast path: look for an existing direct chat with exactly these two members.
  const candidate = await env.DB.prepare(
    `SELECT c.id
       FROM chats c
       JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
       JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
      WHERE c.type = 'direct'
      LIMIT 1`,
  )
    .bind(a, b)
    .first();
  if (candidate) return candidate.id;

  const ts = now();
  const id = uid('c');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO chats (id, type, created_by, created_at, updated_at)
       VALUES (?, 'direct', ?, ?, ?)`,
    ).bind(id, a, ts, ts),
    env.DB.prepare(
      `INSERT INTO chat_members (chat_id, user_id, role, joined_at)
       VALUES (?, ?, 'member', ?), (?, ?, 'member', ?)`,
    ).bind(id, a, ts, id, b, ts),
  ]);
  return id;
}

export async function handleListChats(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');

  const rows = await env.DB.prepare(
    `SELECT c.*,
            (SELECT json_object(
                'id', m.id, 'sender_id', m.sender_id, 'body', m.body,
                'kind', m.kind, 'created_at', m.created_at)
              FROM messages m
              WHERE m.chat_id = c.id AND m.deleted_at IS NULL
              ORDER BY m.created_at DESC LIMIT 1) AS last_message_json
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
      WHERE cm.user_id = ?
      ORDER BY c.updated_at DESC
      LIMIT 200`,
  )
    .bind(me.id)
    .all();

  // For direct chats, fetch the peer for display.
  const chats = [];
  for (const c of rows.results || []) {
    let title = c.title;
    let avatarKey = c.avatar_key;
    let peer = null;
    if (c.type === 'direct') {
      const peerRow = await env.DB.prepare(
        `SELECT u.* FROM chat_members cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.chat_id = ? AND cm.user_id != ? LIMIT 1`,
      )
        .bind(c.id, me.id)
        .first();
      peer = shapeUserPublic(peerRow);
      title = peer?.display_name || peer?.username || 'Чат';
      avatarKey = peer?.avatar_key || null;
    }
    let lastMessage = null;
    if (c.last_message_json) {
      try { lastMessage = JSON.parse(c.last_message_json); } catch { /* ignore */ }
    }
    chats.push({
      id: c.id,
      type: c.type,
      title,
      avatar_key: avatarKey,
      created_at: c.created_at,
      updated_at: c.updated_at,
      peer,
      last_message: lastMessage,
    });
  }
  return json({ chats });
}

export async function handleCreateChat(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');
  const data = await readJson(request);
  if (!data) return error(400, 'invalid_json');

  if (data.type === 'direct') {
    const username = (data.username || '').trim().toLowerCase();
    if (!username) return error(400, 'missing_username');
    const peer = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
      .bind(username)
      .first();
    if (!peer) return error(404, 'user_not_found');
    if (peer.id === me.id) return error(400, 'cannot_message_self');
    const chatId = await findOrCreateDirectChat(env, me.id, peer.id);
    return json({ chat_id: chatId });
  }

  if (data.type === 'group') {
    const title = (data.title || '').trim();
    if (!title || title.length > 80) return error(400, 'invalid_title');
    const ids = Array.isArray(data.member_ids) ? data.member_ids : [];
    if (ids.length > 200) return error(400, 'too_many_members');
    const ts = now();
    const id = uid('c');
    const stmts = [
      env.DB.prepare(
        `INSERT INTO chats (id, type, title, created_by, created_at, updated_at)
         VALUES (?, 'group', ?, ?, ?, ?)`,
      ).bind(id, title, me.id, ts, ts),
      env.DB.prepare(
        `INSERT INTO chat_members (chat_id, user_id, role, joined_at)
         VALUES (?, ?, 'owner', ?)`,
      ).bind(id, me.id, ts),
    ];
    for (const uId of ids) {
      if (uId === me.id) continue;
      const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
        .bind(uId)
        .first();
      if (!u) continue;
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at)
           VALUES (?, ?, 'member', ?)`,
        ).bind(id, uId, ts),
      );
    }
    await env.DB.batch(stmts);
    return json({ chat_id: id });
  }

  return error(400, 'invalid_type');
}

export async function handleGetChat(request, env, chatId) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');
  const member = await ensureMember(env, chatId, me.id);
  if (!member) return error(403, 'not_a_member');

  const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?')
    .bind(chatId)
    .first();
  if (!chat) return error(404, 'chat_not_found');

  const members = await env.DB.prepare(
    `SELECT u.*, cm.role, cm.joined_at
       FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = ?`,
  )
    .bind(chatId)
    .all();

  let title = chat.title;
  let peer = null;
  if (chat.type === 'direct') {
    const peerRow = (members.results || []).find((m) => m.id !== me.id);
    peer = shapeUserPublic(peerRow);
    title = peer?.display_name || peer?.username || 'Чат';
  }

  return json({
    chat: {
      id: chat.id,
      type: chat.type,
      title,
      avatar_key: chat.avatar_key,
      created_at: chat.created_at,
      updated_at: chat.updated_at,
      peer,
      members: (members.results || []).map((m) => ({
        ...shapeUserPublic(m),
        role: m.role,
      })),
    },
  });
}

export async function handleListMessages(request, env, chatId) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');
  const member = await ensureMember(env, chatId, me.id);
  if (!member) return error(403, 'not_a_member');

  const url = new URL(request.url);
  const before = url.searchParams.get('before');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);

  let query = `SELECT * FROM messages WHERE chat_id = ? AND deleted_at IS NULL`;
  const args = [chatId];
  if (before) {
    query += ' AND created_at < ?';
    args.push(parseInt(before, 10));
  }
  query += ' ORDER BY created_at DESC LIMIT ?';
  args.push(limit);

  const res = await env.DB.prepare(query).bind(...args).all();
  const messages = (res.results || []).map(shapeMessage).reverse();
  return json({ messages });
}

export async function handleSendMessage(request, env, chatId) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');
  const member = await ensureMember(env, chatId, me.id);
  if (!member) return error(403, 'not_a_member');

  const data = await readJson(request);
  if (!data) return error(400, 'invalid_json');
  const body = typeof data.body === 'string' ? data.body : '';
  const kind = data.kind || 'text';
  const attachmentKey = data.attachment_key || null;
  const attachmentMeta = data.attachment_meta
    ? JSON.stringify(data.attachment_meta)
    : null;
  const replyTo = data.reply_to_id || null;

  if (!['text', 'image', 'file', 'voice'].includes(kind)) {
    return error(400, 'invalid_kind');
  }
  if (kind === 'text' && !body.trim()) return error(400, 'empty_body');
  if (kind !== 'text' && !attachmentKey) return error(400, 'missing_attachment');
  if (body.length > 4000) return error(400, 'body_too_long');

  const id = uid('m');
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, chat_id, sender_id, body, kind,
                              attachment_key, attachment_meta, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, chatId, me.id, body, kind, attachmentKey, attachmentMeta, replyTo, ts),
    env.DB.prepare('UPDATE chats SET updated_at = ?, last_message_id = ? WHERE id = ?')
      .bind(ts, id, chatId),
  ]);

  const message = shapeMessage({
    id,
    chat_id: chatId,
    sender_id: me.id,
    body,
    kind,
    attachment_key: attachmentKey,
    attachment_meta: attachmentMeta,
    reply_to_id: replyTo,
    edited_at: null,
    deleted_at: null,
    created_at: ts,
  });

  await fanout(env, chatId, { type: 'message', message });
  return json({ message });
}

export async function handleDeleteMessage(request, env, chatId, messageId) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');
  const m = await env.DB.prepare(
    'SELECT * FROM messages WHERE id = ? AND chat_id = ?',
  )
    .bind(messageId, chatId)
    .first();
  if (!m) return error(404, 'not_found');
  if (m.sender_id !== me.id) return error(403, 'forbidden');
  const ts = now();
  await env.DB.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?')
    .bind(ts, messageId)
    .run();
  await fanout(env, chatId, { type: 'message_deleted', message_id: messageId });
  return json({ ok: true });
}

export async function handleMarkRead(request, env, chatId) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');
  const member = await ensureMember(env, chatId, me.id);
  if (!member) return error(403, 'not_a_member');
  const data = await readJson(request);
  const messageId = data?.message_id;
  if (!messageId) return error(400, 'missing_message_id');
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO read_state (chat_id, user_id, message_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET message_id = excluded.message_id, updated_at = excluded.updated_at`,
  )
    .bind(chatId, me.id, messageId, ts)
    .run();
  await fanout(env, chatId, {
    type: 'read',
    user_id: me.id,
    message_id: messageId,
  });
  return json({ ok: true });
}

export async function handleSearchUsers(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return json({ users: [] });
  const rows = await env.DB.prepare(
    `SELECT * FROM users
       WHERE (username LIKE ? OR LOWER(display_name) LIKE ?) AND id != ?
       ORDER BY username LIMIT 25`,
  )
    .bind(`%${q}%`, `%${q}%`, me.id)
    .all();
  return json({ users: (rows.results || []).map(shapeUserPublic) });
}
