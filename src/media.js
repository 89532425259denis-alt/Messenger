// Media uploads (images, voice messages, files) backed by R2.

import { error, json, uid } from './util.js';
import { getSessionUser } from './auth.js';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MiB

const ALLOWED_PREFIXES = ['image/', 'audio/', 'video/'];
const ALLOWED_EXACT = new Set([
  'application/pdf',
  'application/zip',
  'application/octet-stream',
  'text/plain',
]);

function isAllowed(type) {
  if (!type) return true;
  if (ALLOWED_EXACT.has(type)) return true;
  return ALLOWED_PREFIXES.some((p) => type.startsWith(p));
}

export async function handleUpload(request, env) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');

  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  if (!isAllowed(contentType)) return error(415, 'unsupported_media');

  const length = parseInt(request.headers.get('content-length') || '0', 10);
  if (!length || length <= 0) return error(411, 'length_required');
  if (length > MAX_BYTES) return error(413, 'too_large');

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return error(413, 'too_large');

  const key = `${me.id}/${Date.now()}-${uid('a')}`;
  await env.MEDIA.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { uploaded_by: me.id },
  });

  return json({ key, size: body.byteLength, content_type: contentType });
}

export async function handleDownload(request, env, key) {
  const me = await getSessionUser(request, env);
  if (!me) return error(401, 'not_authenticated');

  const obj = await env.MEDIA.get(key);
  if (!obj) return error(404, 'not_found');

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'private, max-age=31536000');
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
}
