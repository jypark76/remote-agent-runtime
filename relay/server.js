const http = require('http');
const WS   = require('ws');
const fs   = require('fs');
const path = require('path');

const rooms = {}; // token -> { host: ws|null, clients: ws[], pending: {} }

function getRoom(token) {
  if (!rooms[token]) rooms[token] = { host: null, clients: [], pending: {} };
  return rooms[token];
}

const MIME_TYPES = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }

  // Static assets: /assets/filename
  if (req.url.startsWith('/assets/')) {
    const filename = path.basename(req.url.split('?')[0]);
    const ext = path.extname(filename).toLowerCase();
    const filePath = path.join(__dirname, 'assets', filename);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'public,max-age=86400' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // File download proxy: /file?token=&chatId=&filename=
  if (req.url.startsWith('/file')) {
    const url = new URL(req.url, 'http://localhost');
    const token    = url.searchParams.get('token');
    const chatId   = url.searchParams.get('chatId');
    const filename = url.searchParams.get('filename');
    if (!token || !chatId || !filename) { res.writeHead(400); res.end('missing params'); return; }
    const room = rooms[token];
    if (!room || !room.host || room.host.readyState !== WS.OPEN) { res.writeHead(503); res.end('host offline'); return; }

    const id = Math.random().toString(36).slice(2) + Date.now();

    room.pending[id] = (body) => {
      if (!body || body.error || !body.b64) { res.writeHead(404); res.end((body && body.error) || 'not found'); return; }
      const buf  = Buffer.from(body.b64, 'base64');
      const safe = filename.replace(/"/g, '_');
      res.writeHead(200, {
        'Content-Type':        body.mime || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safe}"`,
        'Content-Length':      buf.length,
      });
      res.end(buf);
    };

    const userToken = url.searchParams.get('userToken') || '';
    room.host.send(JSON.stringify({
      type: 'api', id, method: 'GET',
      path: `/api/chats/${chatId}/files/${encodeURIComponent(filename)}`,
      userToken,
    }));
    return;
  }

  // Chunked export download: /export-download?token=&chatId=&filename=&realFilename=&userToken=
  if (req.url.startsWith('/export-download')) {
    const url = new URL(req.url, 'http://localhost');
    const token       = url.searchParams.get('token');
    const chatId      = url.searchParams.get('chatId');
    const filename    = url.searchParams.get('filename');
    const realFilename = url.searchParams.get('realFilename') || filename;
    const userToken   = url.searchParams.get('userToken') || '';
    if (!token || !chatId || !filename) { res.writeHead(400); res.end('missing params'); return; }
    const room = rooms[token];
    if (!room || !room.host || room.host.readyState !== WS.OPEN) { res.writeHead(503); res.end('host offline'); return; }

    const id = Math.random().toString(36).slice(2) + Date.now();
    if (!room.pendingDownloads) room.pendingDownloads = {};
    let headersSent = false;

    room.pendingDownloads[id] = (chunk) => {
      if (chunk.error) {
        if (!headersSent) { res.writeHead(500); res.end(chunk.error); }
        else res.end();
        delete room.pendingDownloads[id];
        return;
      }
      if (!headersSent) {
        headersSent = true;
        const safe = realFilename.replace(/"/g, '_');
        res.writeHead(200, {
          'Content-Type': chunk.mime || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${safe}"`,
          'Transfer-Encoding': 'chunked',
        });
      }
      if (chunk.data) res.write(Buffer.from(chunk.data, 'base64'));
      if (chunk.final) { res.end(); delete room.pendingDownloads[id]; }
    };

    room.host.send(JSON.stringify({ type: 'download_start', id, chatId, filename, userToken }));
    return;
  }

  const html = fs.readFileSync(path.join(__dirname, 'index.html'));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

const wss = new WS.Server({ server });

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const role  = url.searchParams.get('role'); // 'host' or 'client'

  if (!token || !role) { ws.close(4000, 'missing params'); return; }

  const room = getRoom(token);

  if (role === 'host') {
    if (room.host) room.host.close(4001, 'replaced');
    room.host = ws;
    console.log(`[${token.slice(0,8)}] host connected`);

    room.clients.forEach(c => {
      if (c.readyState === WS.OPEN)
        c.send(JSON.stringify({ type: 'host_connected' }));
    });

    ws.on('message', raw => {
      const str = raw.toString();
      try {
        const msg = JSON.parse(str);
        // Route api_response to pending HTTP downloads first
        if (msg.type === 'api_response' && room.pending[msg.id]) {
          room.pending[msg.id](msg.body);
          delete room.pending[msg.id];
          return;
        }
        // Route download chunks to pending chunked downloads
        if (msg.type === 'download_chunk' && room.pendingDownloads && room.pendingDownloads[msg.id]) {
          room.pendingDownloads[msg.id](msg);
          return;
        }
      } catch {}
      // Forward everything else to clients
      room.clients.forEach(c => {
        if (c.readyState === WS.OPEN) c.send(str);
      });
    });

    ws.on('close', () => {
      if (room.host !== ws) return; // new host already replaced us — don't clobber it
      room.host = null;
      console.log(`[${token.slice(0,8)}] host disconnected`);
      room.clients.forEach(c => {
        if (c.readyState === WS.OPEN)
          c.send(JSON.stringify({ type: 'host_disconnected' }));
      });
    });

  } else {
    room.clients.push(ws);
    console.log(`[${token.slice(0,8)}] client connected`);

    ws.send(JSON.stringify({
      type: room.host && room.host.readyState === WS.OPEN
        ? 'host_connected' : 'host_disconnected'
    }));

    ws.on('message', raw => {
      if (room.host && room.host.readyState === WS.OPEN)
        room.host.send(raw.toString());
    });

    ws.on('close', () => {
      room.clients = room.clients.filter(c => c !== ws);
    });
  }
});

const PORT = process.env.PORT || 3580;
server.listen(PORT, () => console.log(`relay listening on port ${PORT}`));
