// Durable Object that fans out chat events to connected WebSocket clients
// belonging to a single chat. One instance per chat ID.

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {Map<WebSocket, { userId: string }>} */
    this.sockets = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/broadcast')) {
      const data = await request.json();
      this.broadcast(data);
      return new Response('ok');
    }

    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const userId = url.searchParams.get('user_id');
    if (!userId) return new Response('missing user_id', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.sockets.set(server, { userId });

    server.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'typing') {
        this.broadcast({ type: 'typing', user_id: userId }, server);
      } else if (msg.type === 'ping') {
        try {
          server.send(JSON.stringify({ type: 'pong', t: Date.now() }));
        } catch { /* ignore */ }
      }
    });

    const close = () => {
      this.sockets.delete(server);
      this.broadcast({ type: 'presence', user_id: userId, online: false });
    };
    server.addEventListener('close', close);
    server.addEventListener('error', close);

    this.broadcast({ type: 'presence', user_id: userId, online: true });

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(payload, except) {
    const data = JSON.stringify(payload);
    for (const [ws] of this.sockets) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // Drop dead sockets quietly.
        this.sockets.delete(ws);
      }
    }
  }
}
