// DEVO+ messenger — Cloudflare Worker entry point.
// Routes /api/* to JSON handlers, /ws/:chatId to a Durable Object,
// /media/:key to R2, and falls back to the static frontend (ASSETS binding).

import { ChatRoom } from './chat-room.js';
import {
  handleLogin,
  handleLogout,
  handleMe,
  handleRegister,
  handleUpdateProfile,
  getSessionUser,
} from './auth.js';
import {
  handleCreateChat,
  handleDeleteMessage,
  handleGetChat,
  handleListChats,
  handleListMessages,
  handleMarkRead,
  handleSearchUsers,
  handleSendMessage,
} from './chats.js';
import { handleDownload, handleUpload } from './media.js';
import { error } from './util.js';

export { ChatRoom };

const API = '/api/';

function route(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '');
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.slice(API.length);
  const method = request.method;

  // Public auth.
  if (method === 'POST' && path === 'auth/register') return handleRegister(request, env);
  if (method === 'POST' && path === 'auth/login') return handleLogin(request, env);
  if (method === 'POST' && path === 'auth/logout') return handleLogout(request, env);
  if (method === 'GET' && path === 'auth/me') return handleMe(request, env);
  if (method === 'PATCH' && path === 'me') return handleUpdateProfile(request, env);

  // Chats.
  if (method === 'GET' && path === 'chats') return handleListChats(request, env);
  if (method === 'POST' && path === 'chats') return handleCreateChat(request, env);

  let m = path.match(/^chats\/([^/]+)$/);
  if (m && method === 'GET') return handleGetChat(request, env, m[1]);

  m = path.match(/^chats\/([^/]+)\/messages$/);
  if (m && method === 'GET') return handleListMessages(request, env, m[1]);
  if (m && method === 'POST') return handleSendMessage(request, env, m[1]);

  m = path.match(/^chats\/([^/]+)\/messages\/([^/]+)$/);
  if (m && method === 'DELETE') return handleDeleteMessage(request, env, m[1], m[2]);

  m = path.match(/^chats\/([^/]+)\/read$/);
  if (m && method === 'POST') return handleMarkRead(request, env, m[1]);

  if (method === 'GET' && path === 'users/search') return handleSearchUsers(request, env);

  if (method === 'POST' && path === 'media') return handleUpload(request, env);

  return error(404, 'not_found');
}

async function handleWebSocket(request, env, chatId) {
  if (request.headers.get('upgrade') !== 'websocket') {
    return error(426, 'expected_websocket');
  }
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');

  const member = await env.DB.prepare(
    'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
  )
    .bind(chatId, me.id)
    .first();
  if (!member) return error(403, 'not_a_member');

  const id = env.CHAT_ROOM.idFromName(chatId);
  const stub = env.CHAT_ROOM.get(id);
  const url = new URL(`https://chat-room/ws?user_id=${encodeURIComponent(me.id)}`);
  return stub.fetch(url.toString(), request);
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(API)) {
      try {
        return await handleApi(request, env);
      } catch (e) {
        console.error('api_error', e);
        return error(500, 'server_error');
      }
    }

    const wsChat = route(url.pathname, '/ws/');
    if (wsChat) return handleWebSocket(request, env, wsChat);

    const mediaKey = route(url.pathname, '/media/');
    if (mediaKey) return handleDownload(request, env, decodeURIComponent(mediaKey));

    // Fall through to static assets (frontend SPA).
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return error(404, 'not_found');
  },
};
