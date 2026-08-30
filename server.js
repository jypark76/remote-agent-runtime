const express    = require('express');
const http       = require('http');
const WS         = require('ws');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const crypto     = require('crypto');
const { spawn, exec, execSync } = require('child_process');
const { v4: uuid } = require('uuid');

const app    = express();
const server = http.createServer(app);
const wss    = new WS.Server({ server });
const PORT   = 3579;

const CHATS  = path.join(__dirname, 'chats');
const CLAUDE = 'C:\\Users\\JPark108\\.local\\bin\\claude.exe';

if (!fs.existsSync(CHATS)) fs.mkdirSync(CHATS, { recursive: true });

// ---- Repo size ----
let diskTotal = 0;
function refreshDiskTotal() {
  try {
    const out = execSync('powershell -Command "$d=Get-PSDrive C; $d.Used+$d.Free"', { stdio: ['pipe','pipe','pipe'] }).toString().trim();
    const n = parseInt(out);
    if (!isNaN(n) && n > 0) diskTotal = n;
  } catch {}
}
refreshDiskTotal();
setInterval(refreshDiskTotal, 60 * 60 * 1000);

let repoSizeBytes = 0, repoSizeRunning = false, repoSizeDebounce = null, repoSizeTs = 0;
async function walkSize(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const sizes = await Promise.all(entries.map(async e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walkSize(full);
      if (e.isFile()) { try { return (await fs.promises.stat(full)).size; } catch {} }
      return 0;
    }));
    return sizes.reduce((a, b) => a + (b || 0), 0);
  } catch {}
  return 0;
}
async function calcRepoSize() {
  if (repoSizeRunning) return;
  repoSizeRunning = true;
  try { repoSizeBytes = await walkSize(__dirname); } catch {}
  repoSizeRunning = false;
  repoSizeTs = Date.now();
  broadcastAll({ type: 'storage_update', bytes: repoSizeBytes, total: diskTotal, percent: diskTotal ? +(repoSizeBytes / diskTotal * 100).toFixed(2) : 0 });
}
function scheduleRepoSize() {
  clearTimeout(repoSizeDebounce);
  repoSizeDebounce = setTimeout(calcRepoSize, 3000);
}
scheduleRepoSize();

// ---- Auth ----
function hashPass(s) { return crypto.createHash('sha256').update(s + 'sdb_v1').digest('hex'); }
const USERS = {
  admin: { displayName: process.env.ADMIN_NAME || 'Admin', role: 'admin', passHash: hashPass(process.env.ADMIN_PASS || '') },
  user:  { displayName: process.env.USER_NAME  || 'User',  role: 'user',  passHash: hashPass(process.env.USER_PASS  || '') },
};
const sessions = {}; // token -> { userId, role }
function createAuthSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, role: USERS[userId].role };
  return token;
}
function getAuthSession(token) {
  return (token && sessions[token]) ? sessions[token] : null;
}

app.use(express.json());

// ---- Trust patch ----
try {
  const p = path.join(os.homedir(), '.claude.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const key = os.homedir().replace(/\\/g, '/');
  if (!cfg.projects) cfg.projects = {};
  if (!cfg.projects[key]) cfg.projects[key] = {};
  if (!cfg.projects[key].hasTrustDialogAccepted) {
    cfg.projects[key].hasTrustDialogAccepted = true;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    console.log('Patched trust for', key);
  }
} catch(e) { console.warn('Trust patch failed:', e.message); }

// ---- Git helpers ----
let _sdLogPath = null;
function sdLog(msg) {
  // Use appendFileSync (synchronous) so writes complete before process.exit()
  // Also write to stderr so it appears in terminal even if stdout pipe (tee) closed
  try { process.stderr.write(msg + '\n'); } catch {}
  try { if (_sdLogPath) fs.appendFileSync(_sdLogPath, msg + '\n'); } catch {}
}
function gitRun(cmd) {
  sdLog('$ ' + cmd);
  try {
    const out = execSync(cmd, { cwd: __dirname, stdio: 'pipe' });
    if (out && out.length) sdLog(out.toString().trim());
    return true;
  }
  catch(e) {
    const msg = (e.stderr?.toString().trim() || e.stdout?.toString().trim() || e.message).slice(0,300);
    if (msg) sdLog(msg);
    return false;
  }
}

// ---- Pin helpers ----
function updateGitignorePins() {
  const gitignorePath = path.join(__dirname, '.gitignore');
  let content = '';
  try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch {}
  const lines = [];
  for (const dirName of allChatDirs()) {
    try {
      const c = JSON.parse(fs.readFileSync(convPath(dirName), 'utf8'));
      for (const item of (c.pinnedFiles || [])) {
        lines.push(`!chats/${dirName}/${item}`);
        lines.push(`!chats/${dirName}/${item}/**`);
      }
    } catch {}
  }
  const START = '# BEGIN PINNED FILES';
  const END = '# END PINNED FILES';
  const section = `${START}\n${lines.join('\n')}${lines.length ? '\n' : ''}${END}`;
  if (content.includes(START)) {
    const re = new RegExp(START + '[\\s\\S]*?' + END);
    content = content.replace(re, section);
  } else {
    content = content.trimEnd() + '\n\n' + section + '\n';
  }
  fs.writeFileSync(gitignorePath, content);
}
function gitPinItem(chat, item) {
  const p = `chats/${chat.dirName}/${item}`;
  try { execSync(`git add --force "${p}"`, { cwd: __dirname, stdio: 'pipe' }); } catch {}
}
function gitUnpinItem(chat, item) {
  const p = `chats/${chat.dirName}/${item}`;
  try { execSync(`git rm --cached -r "${p}"`, { cwd: __dirname, stdio: 'pipe' }); } catch {}
}
function deleteIncognitoChats() {
  const chats = listChats().filter(c => c.incognito);
  for (const chat of chats) {
    const sess = chatSessions[chat.id];
    if (sess && sess.proc) { try { sess.proc.kill('SIGTERM'); } catch {} }
    const chatDir = path.join(CHATS, chat.dirName);
    if (fs.existsSync(chatDir)) { try { fs.rmSync(chatDir, { recursive: true, force: true }); } catch {} }
    delete chatSessions[chat.id];
    chatCache.delete(chat.id);
  }
}

function shutdownSync() {
  _sdLogPath = path.join(__dirname, 'logs', 'shutdown_' + Date.now() + '.txt');
  sdLog('\n=== Shutdown ' + new Date().toISOString() + ' ===');
  sdLog('deleting incognito chats ...');
  deleteIncognitoChats();
  sdLog('git add -A ...');
  gitRun('git add -A');
  sdLog('force-adding pinned files ...');
  for (const dirName of allChatDirs()) {
    try {
      const c = JSON.parse(fs.readFileSync(convPath(dirName), 'utf8'));
      for (const item of (c.pinnedFiles || [])) {
        gitRun(`git add --force "chats/${dirName}/${item}"`);
      }
    } catch {}
  }
  sdLog('git commit ...');
  gitRun('git commit -m "shutdown sync"');
  sdLog('git push ...');
  gitRun('git push');
  // Remove stale lock files that git push may leave behind
  try { const lk = path.join(__dirname, '.git', 'objects', 'info', 'commit-graph.lock'); if (fs.existsSync(lk)) fs.unlinkSync(lk); } catch {}
  sdLog('git gc ...');
  try { const lk = path.join(__dirname, '.git', 'objects', 'info', 'commit-graph.lock'); if (fs.existsSync(lk)) fs.unlinkSync(lk); } catch {}
  gitRun('git gc --prune=now');
  sdLog('=== Done. Log: ' + _sdLogPath + ' ===');
  process.exit(0);
}
process.on('SIGINT', shutdownSync);
process.on('SIGTERM', shutdownSync);

// ---- Name helpers ----
function sanitizeName(title) {
  return title.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'chat';
}
function uniqueDirName(base) {
  let name = base, i = 1;
  while (fs.existsSync(path.join(CHATS, name))) name = `${base}-${i++}`;
  return name;
}
function nextIncognitoDirName() {
  let i = 1;
  while (fs.existsSync(path.join(CHATS, `incognito-${i}`))) i++;
  return `incognito-${i}`;
}

// ---- Chat CRUD ----
function convPath(dirName) { return path.join(CHATS, dirName, 'conversation.json'); }

function resolveOwner(chat) {
  return chat.ownerId || chat.avatarPref || 'admin';
}

// In-memory chat cache: id -> chat object. Invalidated on write/delete.
const chatCache = new Map();

function loadChatById(id) {
  if (chatCache.has(id)) return chatCache.get(id);
  for (const d of allChatDirs()) {
    const p = convPath(d);
    if (!fs.existsSync(p)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      chatCache.set(c.id, c);
      if (c.id === id) return c;
    } catch {}
  }
  return null;
}
function loadChat(id) { return loadChatById(id); }

const CLAUDE_MD = `# remote_claude Chat Environment

**Source priority — always follow this order:**
1. Pinned files (if any) — always read and defer to these first
2. Other files in the chat directory
3. Any .md file anywhere (this file, other chat .md files, global .md files) — always last; never consult any .md before the above sources

You are running inside remote_claude, a system that connects Claude Code to the user's iPhone.

**This is an admin chat. You have FULL filesystem access** — you can read, write, and navigate any directory on this machine. Your default working directory is this chat's folder, but you are NOT restricted to it.

When the user asks you to create or send a file in this chat, create it with a relative path (e.g. \`report.md\`, \`chart.png\`). Tell the user it will appear in the chat automatically.

Files the user uploads from their phone are saved in this directory and can be read by name.

To configure hooks or settings for this chat, edit \`.claude/settings.json\` using the Bash tool (e.g. \`node -e "..."\` or shell redirection) — the Write/Edit tools are blocked for \`.claude/\` paths by Claude Code itself.

**Never generate markdown tables.** Use bullet lists, numbered lists, or plain prose instead — tables are unreadable in this chat interface.

When writing output files, use the exact same filename as the input file. Do not append timestamps, numbers, or any suffix to the filename.

**Never output raw XML, tool-call markup, or \`<invoke>\` / \`<function_calls>\` blocks in your response text.** Use tools normally — do not narrate or echo the XML syntax.

**When unsure about format, naming, structure, or expected output for any task, always inspect existing files in this chat directory first (e.g. \`ls\`, read a relevant file) before assuming any default. Never guess — look first.**
`;

const INCOGNITO_CLAUDE_MD = `# remote_claude Incognito Session

You are running inside an INCOGNITO session. This is a private, temporary conversation.

## !! HARD SECURITY RESTRICTION !!

You are ABSOLUTELY RESTRICTED to this chat's folder only.

You MUST NOT, under any circumstances:
- Read, write, list, or access any file outside this directory using absolute paths
- Use \`../\` or any path traversal to navigate above this directory
- Run any shell command that accesses files or directories outside the current folder
- Access memory files, other chat directories, config files, or any part of the broader file system
- Use tools like Glob, Grep, or Bash to search or operate outside this directory

If asked to access anything outside this folder, REFUSE and explain you are locked to this chat directory.

**Additional incognito rules:**
- Do NOT use any memory tools or store any information
- Do NOT recall or reference anything from previous conversations or stored memories
- Treat this as a completely fresh interaction with an anonymous user — you know nothing about them

**Your working directory is this chat's folder.** Any files you CREATE here are automatically delivered to the user's phone as downloadable (or viewable) attachments after your response.

Files the user uploads from their phone are also saved in this directory - you can read them directly by name (relative path only).

To configure hooks or settings for this chat, edit \`.claude/settings.json\` using the Bash tool (e.g. \`node -e "..."\` or shell redirection) — the Write/Edit tools are blocked for \`.claude/\` paths by Claude Code itself.

**Never generate markdown tables.** Use bullet lists, numbered lists, or plain prose instead — tables are unreadable in this chat interface.

When writing output files, use the exact same filename as the input file. Do not append timestamps, numbers, or any suffix to the filename.

**When unsure about format, naming, structure, or expected output for any task, always inspect existing files in this chat directory first (e.g. \`ls\`, read a relevant file) before assuming any default. Never guess — look first.**
`;

const USER_CLAUDE_MD = `# remote_claude Chat Environment

**Source priority — always follow this order:**
1. Pinned files (if any) — always read and defer to these first
2. Other files in the chat directory
3. Any .md file anywhere (this file, other chat .md files, global .md files) — always last; never consult any .md before the above sources

You are running inside remote_claude, a system that connects Claude Code to the user's phone.

## !! HARD SECURITY RESTRICTION !!

You are ABSOLUTELY RESTRICTED to this chat's folder only.

You MUST NOT, under any circumstances:
- Read, write, list, or access any file outside this directory using absolute paths
- Use \`../\` or any path traversal to navigate above this directory
- Run any shell command that accesses files or directories outside the current folder
- Access memory files, other chat directories, config files, or any part of the broader file system
- Use tools like Glob, Grep, or Bash to search or operate outside this directory

If asked to access anything outside this folder, REFUSE and explain you are locked to this chat directory.

**Your working directory is this chat's folder.** Files you create here are delivered to the user's phone automatically. Files the user uploads are saved here and can be read by name (relative path only).

You may reference files from other chat folders that belong to this same user. If you need to find the user's other chat folders, look only in directories whose conversation.json has the same ownerId as this chat. NEVER list, read, reference, or acknowledge the existence of any chat folder owned by a different user.

To configure hooks or settings for this chat, edit \`.claude/settings.json\` using the Bash tool (e.g. \`node -e "..."\` or shell redirection) — the Write/Edit tools are blocked for \`.claude/\` paths by Claude Code itself.

**Never generate markdown tables.** Use bullet lists, numbered lists, or plain prose instead — tables are unreadable in this chat interface.

When writing output files, use the exact same filename as the input file. Do not append timestamps, numbers, or any suffix to the filename.

**When unsure about format, naming, structure, or expected output for any task, always inspect existing files in this chat directory first (e.g. \`ls\`, read a relevant file) before assuming any default. Never guess — look first.**
`;

function chatClaudeMd(chat) {
  let base;
  if (chat.incognito) base = INCOGNITO_CLAUDE_MD;
  else { const owner = resolveOwner(chat); base = owner === 'admin' ? CLAUDE_MD : USER_CLAUDE_MD; }
  const pins = chat.pinnedFiles || [];
  if (pins.length) {
    base = base.trimEnd() + '\n\n## Pinned Files\nThe following files/directories are pinned by the user. Always reference and defer to them when relevant:\n' + pins.map(p => `- ${p}`).join('\n') + '\n';
  }
  return base;
}

function saveChat(chat) {
  const dir = path.join(CHATS, chat.dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Only write CLAUDE.md on initial chat creation; memory updater owns it after that
  const claudeMdPath = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) fs.writeFileSync(claudeMdPath, chatClaudeMd(chat));
  fs.writeFileSync(convPath(chat.dirName), JSON.stringify(chat, null, 2));
  chatCache.set(chat.id, chat);
  // Pre-create .claude/settings.json so Claude can edit it (Claude Code blocks creating it from scratch)
  const claudeDir = path.join(dir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, '{}');
  }
}

function allChatDirs() {
  if (!fs.existsSync(CHATS)) return [];
  return fs.readdirSync(CHATS, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function listChats() {
  return allChatDirs()
    .map(d => {
      try {
        const c = JSON.parse(fs.readFileSync(convPath(d), 'utf8'));
        chatCache.set(c.id, c);
        return c;
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function appendMessage(chat, role, text, files, thinkMs) {
  const entry = { role, text, ts: Date.now() };
  if (files && files.length) entry.files = files;
  if (thinkMs) entry.thinkMs = thinkMs;
  chat.messages.push(entry);
  chat.updatedAt = Date.now();
  saveChat(chat);
}

// ---- File helpers ----
const HIDDEN_FILES = new Set(['conversation.json', 'CLAUDE.md']);
const ESSENTIAL_ITEMS = new Set(['conversation.json', 'CLAUDE.md', '.claude']);
function getChatFiles(chat) {
  const dir = path.join(CHATS, chat.dirName);
  try {
    return fs.readdirSync(dir).filter(f => {
      if (HIDDEN_FILES.has(f)) return false;
      return fs.statSync(path.join(dir, f)).isFile();
    });
  } catch { return []; }
}
function getChatItems(chat) {
  const dir = path.join(CHATS, chat.dirName);
  try {
    return fs.readdirSync(dir)
      .filter(f => !ESSENTIAL_ITEMS.has(f))
      .map(f => {
        try { const st = fs.statSync(path.join(dir, f)); return { name: f, isDir: st.isDirectory() }; } catch { return null; }
      }).filter(Boolean);
  } catch { return []; }
}

const MIME = { '.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.gif':'image/gif', '.txt':'text/plain', '.md':'text/markdown',
  '.json':'application/json', '.js':'text/javascript', '.ts':'text/typescript',
  '.html':'text/html', '.css':'text/css', '.csv':'text/csv', '.zip':'application/zip',
  '.py':'text/x-python', '.sh':'text/x-shellscript',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls':'application/vnd.ms-excel',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.sdlxliff':'application/octet-stream' };

function readFileForDownload(chat, filename) {
  const owner = resolveOwner(chat);
  const isAdminChat = !chat.incognito && owner === 'admin';
  const resolved = path.resolve(path.join(CHATS, chat.dirName, filename));
  if (isAdminChat) {
    // Admin chats: unrestricted filesystem access
  } else if (!chat.incognito) {
    // Any authenticated user: read access to any non-incognito chat directory
    const allChatDirs = listChats()
      .filter(c => !c.incognito)
      .map(c => path.resolve(path.join(CHATS, c.dirName)));
    if (!allChatDirs.some(dir => resolved.startsWith(dir))) return null;
  } else {
    // Incognito: locked to its own chat dir only
    const base = path.resolve(path.join(CHATS, chat.dirName));
    if (!resolved.startsWith(base)) return null;
  }
  if (!fs.existsSync(resolved)) return null;
  const ext = path.extname(resolved).toLowerCase();
  return { b64: fs.readFileSync(resolved).toString('base64'), mime: MIME[ext] || 'application/octet-stream', filename: path.basename(resolved) };
}

function exportChatZip(chat) {
  return new Promise((resolve, reject) => {
    const chatDir = path.join(CHATS, chat.dirName);
    const tmpZip = path.join(os.tmpdir(), 'export_' + chat.id + '_' + Date.now() + '.zip');
    exec(`powershell -Command "Compress-Archive -Path '${chatDir}' -DestinationPath '${tmpZip}' -Force"`, { stdio: 'pipe' }, (err) => {
      if (err) { try { fs.unlinkSync(tmpZip); } catch {} reject(err); return; }
      try {
        const b64 = fs.readFileSync(tmpZip).toString('base64');
        resolve({ b64, filename: chat.dirName + '.zip', mime: 'application/zip' });
      } catch(e) { reject(e); }
      finally { try { fs.unlinkSync(tmpZip); } catch {} }
    });
  });
}

// Relay-path export: writes zip to chat dir so it can be served via HTTP /file proxy
// (avoids sending a multi-MB base64 blob as a single WebSocket frame)
function exportChatZipToFile(chat) {
  return new Promise((resolve, reject) => {
    const chatDir = path.join(CHATS, chat.dirName);
    const tmpZip  = path.join(os.tmpdir(), 'export_' + chat.id + '_' + Date.now() + '.zip');
    const zipName = '_export_' + Date.now() + '.zip';
    const zipPath = path.join(chatDir, zipName);
    exec(`powershell -Command "Compress-Archive -Path '${chatDir}' -DestinationPath '${tmpZip}' -Force"`, { stdio: 'pipe' }, (err) => {
      if (err) { try { fs.unlinkSync(tmpZip); } catch {} reject(err); return; }
      try {
        fs.renameSync(tmpZip, zipPath);
        setTimeout(() => { try { fs.unlinkSync(zipPath); } catch {} }, 5 * 60 * 1000);
        resolve({ zipName, filename: chat.dirName + '.zip' });
      } catch(e) { try { fs.unlinkSync(tmpZip); } catch {} reject(e); }
    });
  });
}

// ---- Session tracking ----
const chatSessions = {}; // chatId -> { sessionId, running, proc, startTime }

function getChatSession(chatId) {
  if (!chatSessions[chatId]) chatSessions[chatId] = { sessionId: null, running: false };
  return chatSessions[chatId];
}

// ---- Incognito stats ----
function incognitoStats(chats) {
  const all = chats || listChats();
  const activeIncognito = all.filter(c => c.incognito).length;
  return { activeIncognito, totalUsers: Object.keys(USERS).length };
}

// ---- Broadcast ----
// broadcast: sends to clients subscribed to a specific chat
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of wss.clients)
    if (ws.readyState === WS.OPEN && ws.chatId === msg.chatId) ws.send(raw);
  if (relayConn && relayConn.readyState === WS.OPEN) relayConn.send(raw);
}
// broadcastAll: sends to all connected clients (e.g. storage updates)
function broadcastAll(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of wss.clients)
    if (ws.readyState === WS.OPEN) ws.send(raw);
  if (relayConn && relayConn.readyState === WS.OPEN) relayConn.send(raw);
}

// ---- Tool call preview formatter ----
function formatToolPreview(name, input) {
  const short = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (name === 'Edit' || name === 'Write' || name === 'Read' || name === 'MultiEdit') {
    const p = input.file_path || input.path || '';
    return `${name}(${short(p.replace(/^.*[\\/]/, '').slice(0, 50))})`;
  }
  if (name === 'Bash') return `Bash(${short(input.command)})`;
  if (name === 'Grep') return `Grep(${short(input.pattern)})`;
  if (name === 'Glob') return `Glob(${short(input.pattern)})`;
  if (name === 'WebFetch' || name === 'WebSearch') return `${name}(${short(input.url || input.query)})`;
  if (name === 'Agent') return `Agent(${short(input.description || input.prompt)})`;
  const firstVal = Object.values(input).find(v => typeof v === 'string') || '';
  return `${name}(${short(firstVal)})`;
}

// ---- Auto CLAUDE.md memory update ----
const memoryDebounce = {};

function scheduleMemoryUpdate(chatId) {
  clearTimeout(memoryDebounce[chatId]);
  memoryDebounce[chatId] = setTimeout(() => {
    delete memoryDebounce[chatId];
    updateChatMemory(chatId);
  }, 10000);
}

function updateChatMemory(chatId) {
  const chat = loadChatById(chatId);
  if (!chat || chat.incognito || chat.messages.length < 2) return;

  const chatDir = path.join(CHATS, chat.dirName);
  const claudeMdPath = path.join(chatDir, 'CLAUDE.md');

  let existing = '';
  try { existing = fs.readFileSync(claudeMdPath, 'utf8').trim(); } catch {}

  const msgs = chat.messages.slice(-30);
  const history = msgs.map(m => `[${m.role === 'user' ? 'User' : 'Claude'}]: ${(m.text || '').slice(0, 2000)}`).join('\n\n');

  const prompt = `You are updating a persistent CLAUDE.md memory file for this chat session. This file is automatically read at the start of every future session to restore full context — it is the only memory that survives across sessions.

${existing ? `Current CLAUDE.md:\n---\n${existing}\n---\n\n` : ''}Recent conversation (${msgs.length} messages):\n---\n${history}\n---\n\nWrite an updated CLAUDE.md. CRITICAL RULES:\n\n1. NEVER delete or remove anything from the existing CLAUDE.md — every line must be preserved exactly as-is.\n2. Only ADD new information from the recent conversation that is not already captured.\n3. Update existing entries in-place only if a value has explicitly changed (e.g. a number was corrected) — keep all surrounding context.\n4. Do not summarize, compress, or rewrite existing content.\n\nNew information to add from recent conversation:\n\n- New facts, decisions, or data points not yet in the file\n- Status updates for ongoing projects\n- New behavioral rules or preferences stated by the user\n- New files, tools, or systems introduced\n\nStructure with clear headers. Do not use any tools — write ONLY the CLAUDE.md content as your response.`;

  const args = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '--print', '-'];
  const proc = spawn(CLAUDE, args, { cwd: chatDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.write(prompt);
  proc.stdin.end();

  let text = '', buf = '';
  proc.stdout.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'assistant')
          for (const block of (ev.message?.content || []))
            if (block.type === 'text') text += block.text;
      } catch {}
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('exit', code => {
    if (code === 0 && text.trim()) {
      const cleaned = text.trim().replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '');
      fs.writeFileSync(claudeMdPath, cleaned + '\n');
      console.log(`[${chatId.slice(0,8)}] CLAUDE.md updated (${cleaned.length} chars)`);
    } else {
      console.log(`[${chatId.slice(0,8)}] CLAUDE.md update failed (code=${code})`);
    }
  });
}

// ---- Run Claude ----
function runClaudeMessage(chatId, userText) {
  const chat = loadChatById(chatId);
  if (!chat) { console.error('chat not found:', chatId); return; }

  const session = getChatSession(chatId);
  if (session.running) { console.log(`[${chatId.slice(0,8)}] busy, ignoring`); return; }
  session.running = true;
  session.startTime = Date.now();

  if (!session.sessionId && chat.sessionId) session.sessionId = chat.sessionId;

  const cwd = path.join(CHATS, chat.dirName);

  let prompt = userText;
  if (!session.sessionId && !chat.incognito && chat.messages.length > 1) {
    const history = chat.messages.slice(0, -1).slice(-10)
      .map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text}`)
      .join('\n\n');
    prompt = `[CONTEXT]\n${history}\n\n[MESSAGE]\n${userText}`;
  }

  const args = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '--print', '-'];
  if (session.sessionId) args.push('--resume', session.sessionId);

  const filesBefore = new Map(getChatFiles(chat).map(f => {
    try { return [f, fs.statSync(path.join(cwd, f)).mtimeMs]; } catch { return [f, 0]; }
  }));
  console.log(`[${chatId.slice(0,8)}] claude in ${chat.dirName}: ${userText.slice(0,60)}`);

  const proc = spawn(CLAUDE, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.write(prompt);
  proc.stdin.end();
  session.proc = proc;

  let responseText = '';
  let lineBuffer = '';

  proc.stdout.on('data', chunk => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
          session.sessionId = ev.session_id;
        }
        if (ev.type === 'assistant') {
          for (const block of (ev.message?.content || [])) {
            if (block.type === 'text') console.log(`[${chatId.slice(0,8)}] text: ${(block.text||'').replace(/\n/g,' ').slice(0,200)}`);
            else if (block.type === 'tool_use') console.log(`[${chatId.slice(0,8)}] tool: ${block.name}(${JSON.stringify(block.input||{}).slice(0,120)})`);
            if (block.type === 'text' && block.text) {
              responseText += block.text;
              broadcast({ type: 'output', chatId, data: block.text });
            }
            if (block.type === 'tool_use') {
              broadcast({ type: 'tool_use', chatId, text: formatToolPreview(block.name, block.input || {}) });
            }
          }
        }
        if (ev.type === 'result' && ev.session_id) {
          session.sessionId = ev.session_id;
        }
      } catch {}
    }
  });

  proc.stderr.on('data', d => {
    const s = d.toString();
    if (!s.includes('stdin') && !s.includes('Waiting')) console.error(`[${chatId.slice(0,8)}] stderr:`, s.slice(0,200));
  });

  proc.on('exit', code => {
    console.log(`[${chatId.slice(0,8)}] exited code=${code}`);
    session.running = false;
    session.proc = null;

    const CLI_ERROR_RE = /^(undefined is not an object|TypeError:|Cannot read prop|ReferenceError:|Error:)/;
    const isCliError = CLI_ERROR_RE.test(responseText.trim());
    const shouldRetry = (code !== 0 && !responseText.trim()) || isCliError;
    if (shouldRetry && session.sessionId && !session._errorRetried) {
      console.log(`[${chatId.slice(0,8)}] ${isCliError ? 'CLI error output' : 'stale session'}, retrying without --resume`);
      session.sessionId = null;
      session._errorRetried = true;
      const fresh = loadChatById(chatId);
      if (fresh) { fresh.sessionId = null; saveChat(fresh); }
      runClaudeMessage(chatId, userText);
      return;
    }
    delete session._errorRetried;

    const fresh = loadChatById(chatId);
    if (fresh) {
      const chatDir = path.join(CHATS, fresh.dirName);
      const changedFiles = getChatFiles(fresh).filter(f => {
        const mtimeBefore = filesBefore.get(f);
        if (mtimeBefore === undefined) return true; // new file
        try { return fs.statSync(path.join(chatDir, f)).mtimeMs > mtimeBefore; } catch { return false; }
      });
      const thinkMs = session.startTime ? Date.now() - session.startTime : 0;
      appendMessage(fresh, 'claude', responseText.trim(), changedFiles.length ? changedFiles : undefined, thinkMs);
      if (session.sessionId) { fresh.sessionId = session.sessionId; saveChat(fresh); }
      else if (code !== 0 && fresh.sessionId) { fresh.sessionId = null; saveChat(fresh); }
      if (changedFiles.length) { broadcast({ type: 'files_update', chatId, files: changedFiles }); scheduleRepoSize(); }
    }

    broadcast({ type: 'response_done', chatId });
    if (code === 0) {
      scheduleMemoryUpdate(chatId);
    } else if (responseText.trim()) {
      // Session died mid-response — update CLAUDE.md immediately so context isn't lost
      clearTimeout(memoryDebounce[chatId]);
      delete memoryDebounce[chatId];
      updateChatMemory(chatId);
    }
  });
}

// ---- REST API ----
const ORDER_FILE = path.join(CHATS, 'order.json');
function loadOrder() { try { return JSON.parse(fs.readFileSync(ORDER_FILE,'utf8')); } catch { return []; } }
function saveOrder(ids) { fs.writeFileSync(ORDER_FILE, JSON.stringify(ids)); }

function getExpressAuth(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || req.query.userToken;
  return getAuthSession(token);
}

app.post('/api/login', (req, res) => {
  const { userId, password } = req.body || {};
  if (!userId || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = USERS[userId];
  if (!user || !process.env[userId === 'admin' ? 'ADMIN_PASS' : 'USER_PASS']) return res.status(401).json({ error: 'Invalid credentials' });
  if (hashPass(password) !== user.passHash) return res.status(401).json({ error: 'Invalid credentials' });
  const token = createAuthSession(userId);
  res.json({ token, userId, displayName: user.displayName, role: user.role });
});

app.get('/api/me', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const user = USERS[auth.userId];
  res.json({ userId: auth.userId, displayName: user.displayName, role: auth.role });
});

app.post('/api/shutdown', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth || auth.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  res.json({ ok: true });
  setTimeout(shutdownSync, 300);
});

app.get('/api/storage', (req, res) => {
  if (Date.now() - repoSizeTs > 30000) scheduleRepoSize();
  res.json({ bytes: repoSizeBytes, total: diskTotal, percent: diskTotal ? +(repoSizeBytes / diskTotal * 100).toFixed(2) : 0 });
});

app.get('/api/chats', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chats = listChats();
  const order = loadOrder();
  const orderMap = new Map(order.map((id, i) => [id, i]));
  chats.sort((a, b) => {
    const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
    const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
    if (ai === Infinity && bi === Infinity) return b.updatedAt - a.updatedAt;
    if (ai === Infinity) return 1; if (bi === Infinity) return -1;
    return ai - bi;
  });
  const newIds = chats.filter(c => !orderMap.has(c.id)).map(c => c.id);
  if (newIds.length) saveOrder([...order, ...newIds]);
  const list = chats.map(c => ({
    id: c.id, title: c.title, dirName: c.dirName, incognito: c.incognito || false,
    ownerId: resolveOwner(c), updatedAt: c.updatedAt,
    preview: c.messages.at(-1)?.text?.slice(0,80) ?? '',
    isRunning: !!(chatSessions[c.id] && chatSessions[c.id].running),
    runStartTime: chatSessions[c.id]?.startTime || null
  }));
  res.json({ chats: list, meta: incognitoStats(chats) });
});

app.patch('/api/chat-order', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be array' });
  saveOrder(ids);
  res.json({ ok: true });
});

app.post('/api/chats', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const title = req.body.title || ('Chat ' + new Date().toLocaleString());
  const incognito = req.body.incognito === true;
  const dirName = incognito ? nextIncognitoDirName() : uniqueDirName(sanitizeName(title));
  const chat = { id: uuid(), title, dirName, incognito: incognito || undefined, ownerId: auth.userId, sessionId: null, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  saveChat(chat);
  scheduleRepoSize();
  res.json(chat);
});

app.get('/api/chats/:id', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const sess = chatSessions[req.params.id];
  res.json({ ...chat, ownerId: resolveOwner(chat), isRunning: !!(sess && sess.running), runStartTime: sess?.startTime || null });
});

app.patch('/api/chats/:id', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const owner = resolveOwner(chat);
  if (auth.role !== 'admin' && owner !== auth.userId) return res.status(403).json({ error: 'Forbidden' });
  if (req.body.title) {
    const newTitle = req.body.title;
    const newBase = sanitizeName(newTitle);
    const newDirName = chat.dirName === newBase ? newBase : uniqueDirName(newBase);
    if (newDirName !== chat.dirName) {
      fs.renameSync(path.join(CHATS, chat.dirName), path.join(CHATS, newDirName));
      chat.dirName = newDirName;
    }
    chat.title = newTitle;
    saveChat(chat);
  }
  res.json({ ok: true, dirName: chat.dirName });
});

app.delete('/api/chats/:id', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (chat) {
    const owner = resolveOwner(chat);
    if (auth.role !== 'admin' && owner !== auth.userId) return res.status(403).json({ error: 'Forbidden' });
    const sess = chatSessions[req.params.id];
    if (sess && sess.proc) { try { sess.proc.kill('SIGTERM'); } catch {} }
    const chatDir = path.join(CHATS, chat.dirName);
    if (fs.existsSync(chatDir)) fs.rmSync(chatDir, { recursive: true, force: true });
  }
  delete chatSessions[req.params.id];
  chatCache.delete(req.params.id);
  broadcast({ type: 'chat_deleted', chatId: req.params.id });
  scheduleRepoSize();
  res.json({ ok: true });
});

app.get('/api/chats/:id/export', async (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  try {
    const result = await exportChatZip(chat);
    const buf = Buffer.from(result.b64, 'base64');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.end(buf);
  } catch(e) { res.status(500).json({ error: 'Export failed: ' + e.message }); }
});

app.post('/api/chats/:id/cleanup-preview', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const owner = resolveOwner(chat);
  if (auth.role !== 'admin' && owner !== auth.userId) return res.status(403).json({ error: 'Forbidden' });
  const days = Math.max(0, parseInt(req.body.days) || 0);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const dir = path.join(CHATS, chat.dirName);
  let totalBytes = 0, count = 0;
  const pinned = new Set(chat.pinnedFiles || []);
  try {
    for (const f of fs.readdirSync(dir).filter(f => !HIDDEN_FILES.has(f) && !pinned.has(f))) {
      try { const st = fs.statSync(path.join(dir, f)); if (st.isFile() && st.mtimeMs < cutoff) { totalBytes += st.size; count++; } } catch {}
    }
  } catch {}
  res.json({ bytes: totalBytes, count });
});

app.post('/api/chats/:id/cleanup', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const owner = resolveOwner(chat);
  if (auth.role !== 'admin' && owner !== auth.userId) return res.status(403).json({ error: 'Forbidden' });
  const days = Math.max(0, parseInt(req.body.days) || 0);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const dir = path.join(CHATS, chat.dirName);
  let freed = 0, deleted = 0;
  const pinned = new Set(chat.pinnedFiles || []);
  try {
    for (const f of fs.readdirSync(dir).filter(f => !HIDDEN_FILES.has(f) && !pinned.has(f))) {
      try { const fp = path.join(dir, f); const st = fs.statSync(fp); if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(fp); freed += st.size; deleted++; } } catch {}
    }
  } catch {}
  scheduleRepoSize();
  res.json({ deleted, freed });
});

app.post('/api/chats/:id/stop', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const sess = chatSessions[req.params.id];
  if (sess && sess.proc) { try { sess.proc.kill('SIGTERM'); } catch {} }
  res.json({ ok: true });
});

// ---- Pin routes ----
app.get('/api/chats/:id/pins', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  res.json({ pinned: chat.pinnedFiles || [], available: getChatItems(chat) });
});

app.post('/api/chats/:id/pins', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  if (auth.role !== 'admin' && resolveOwner(chat) !== auth.userId) return res.status(403).json({ error: 'Forbidden' });
  const { item } = req.body || {};
  if (!item || ESSENTIAL_ITEMS.has(item)) return res.status(400).json({ error: 'invalid item' });
  if (!chat.pinnedFiles) chat.pinnedFiles = [];
  if (!chat.pinnedFiles.includes(item)) {
    chat.pinnedFiles.push(item);
    saveChat(chat);
    updateGitignorePins();
    gitPinItem(chat, item);
  }
  res.json({ ok: true, pinned: chat.pinnedFiles });
});

app.delete('/api/chats/:id/pins/:item', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  if (auth.role !== 'admin' && resolveOwner(chat) !== auth.userId) return res.status(403).json({ error: 'Forbidden' });
  const item = decodeURIComponent(req.params.item);
  if (chat.pinnedFiles) {
    chat.pinnedFiles = chat.pinnedFiles.filter(f => f !== item);
    saveChat(chat);
    updateGitignorePins();
    gitUnpinItem(chat, item);
  }
  res.json({ ok: true, pinned: chat.pinnedFiles || [] });
});

app.get('/api/chats/:id/files', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  res.json(getChatFiles(chat));
});

app.get('/api/chats/:id/files/:filename', (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const result = readFileForDownload(chat, req.params.filename);
  if (!result) return res.status(404).json({ error: 'file not found' });
  const buf = Buffer.from(result.b64, 'base64');
  res.setHeader('Content-Type', result.mime);
  res.setHeader('Content-Disposition', 'attachment; filename="' + result.filename + '"');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const chat = loadChatById(req.params.id);
      cb(chat ? null : new Error('chat not found'), chat ? path.join(CHATS, chat.dirName) : null);
    },
    filename: (_req, file, cb) => { cb(null, file.originalname); }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/chats/:id/upload', upload.single('file'), (req, res) => {
  const auth = getExpressAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const chat = loadChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const owner = resolveOwner(chat);
  if (auth.role !== 'admin' && owner !== auth.userId) return res.status(403).json({ error: 'Forbidden' });
  const prompt = (req.body.message ? req.body.message + '\n' : '') + 'The user attached a file. It is saved as: ' + req.file.filename + ' (in your current directory).';
  appendMessage(chat, 'user', req.body.message || req.file.originalname, [{ filename: req.file.filename, isImage: req.file.mimetype.startsWith('image/') }]);
  runClaudeMessage(req.params.id, prompt);
  res.json({ ok: true });
});

// ---- WebSocket (local) ----
wss.on('connection', ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'join') ws.chatId = msg.chatId;
      if (msg.type === 'input' && (ws.chatId || msg.chatId)) {
        const auth = getAuthSession(msg.userToken || (msg.body && msg.body.userToken));
        if (!auth) return;
        const chatId = msg.chatId || ws.chatId;
        const text = msg.data.replace(/\n$/, '');
        const chat = loadChatById(chatId);
        if (chat) {
          const owner = resolveOwner(chat);
          if (auth.role !== 'admin' && owner !== auth.userId) return;
          appendMessage(chat, 'user', text);
        }
        runClaudeMessage(chatId, text);
      }
    } catch(e) { console.error('ws error:', e.message); }
  });
});

app.use(express.static(path.join(__dirname, 'public')));
server.listen(PORT, '0.0.0.0', () => {
  console.log('remote_claude listening on :' + PORT);
  connectRelay();
});

// ---- Relay ----
const RELAY_URL   = process.env.RELAY_URL;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
let relayConn = null;

function handleApiMsg(method, urlPath, body, auth) {
  try {
    urlPath = urlPath.split('?')[0]; // strip query string before route matching
    // ---- Public routes ----
    if (urlPath === '/api/login' && method === 'POST') {
      const { userId, password } = body || {};
      if (!userId || !password) return { status: 400, body: { error: 'Missing credentials' } };
      const user = USERS[userId];
      const envKey = userId === 'admin' ? 'ADMIN_PASS' : 'USER_PASS';
      if (!user || !process.env[envKey]) return { status: 401, body: { error: 'Invalid credentials' } };
      if (hashPass(password) !== user.passHash) return { status: 401, body: { error: 'Invalid credentials' } };
      const token = createAuthSession(userId);
      return { status: 200, body: { token, userId, displayName: user.displayName, role: user.role } };
    }

    if (urlPath === '/api/me' && method === 'GET') {
      if (!auth) return { status: 401, body: { error: 'Unauthorized' } };
      const user = USERS[auth.userId];
      return { status: 200, body: { userId: auth.userId, displayName: user.displayName, role: auth.role } };
    }

    if (urlPath === '/api/stats' && method === 'GET') {
      if (!auth || auth.role !== 'admin') return { status: 403, body: { error: 'Forbidden' } };
      return { status: 200, body: incognitoStats() };
    }

    if (urlPath === '/api/shutdown' && method === 'POST') {
      if (!auth || auth.role !== 'admin') return { status: 403, body: { error: 'Forbidden' } };
      setTimeout(shutdownSync, 300);
      return { status: 200, body: { ok: true } };
    }

    // ---- Auth required for all below ----
    if (!auth) return { status: 401, body: { error: 'Unauthorized' } };

    const pinMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/pins(?:\/(.+))?$/);
    if (pinMatch) {
      const chat = loadChatById(pinMatch[1]);
      if (!chat) return { status: 404, body: { error: 'not found' } };
      const owner = resolveOwner(chat);
      if (auth.role !== 'admin' && owner !== auth.userId) return { status: 403, body: { error: 'Forbidden' } };
      if (method === 'GET' && !pinMatch[2]) {
        return { status: 200, body: { pinned: chat.pinnedFiles || [], available: getChatItems(chat) } };
      }
      if (method === 'POST' && !pinMatch[2]) {
        const item = body && body.item;
        if (!item || ESSENTIAL_ITEMS.has(item)) return { status: 400, body: { error: 'invalid item' } };
        if (!chat.pinnedFiles) chat.pinnedFiles = [];
        if (!chat.pinnedFiles.includes(item)) { chat.pinnedFiles.push(item); saveChat(chat); updateGitignorePins(); gitPinItem(chat, item); }
        return { status: 200, body: { ok: true, pinned: chat.pinnedFiles } };
      }
      if (method === 'DELETE' && pinMatch[2]) {
        const item = decodeURIComponent(pinMatch[2]);
        if (chat.pinnedFiles) { chat.pinnedFiles = chat.pinnedFiles.filter(f => f !== item); saveChat(chat); updateGitignorePins(); gitUnpinItem(chat, item); }
        return { status: 200, body: { ok: true, pinned: chat.pinnedFiles || [] } };
      }
      return { status: 400, body: { error: 'bad request' } };
    }

    const cleanupMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/(cleanup-preview|cleanup)$/);
    if (cleanupMatch) {
      const chat = loadChatById(cleanupMatch[1]);
      if (!chat) return { status: 404, body: { error: 'not found' } };
      const owner = resolveOwner(chat);
      if (auth.role !== 'admin' && owner !== auth.userId) return { status: 403, body: { error: 'Forbidden' } };
      const days = Math.max(0, parseInt(body && body.days) || 0);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const dir = path.join(CHATS, chat.dirName);
      const pinned = new Set(chat.pinnedFiles || []);
      if (cleanupMatch[2] === 'cleanup-preview') {
        let totalBytes = 0, count = 0;
        try {
          for (const f of fs.readdirSync(dir).filter(f => !HIDDEN_FILES.has(f) && !pinned.has(f))) {
            try { const st = fs.statSync(path.join(dir, f)); if (st.isFile() && st.mtimeMs < cutoff) { totalBytes += st.size; count++; } } catch {}
          }
        } catch {}
        return { status: 200, body: { bytes: totalBytes, count } };
      } else {
        let freed = 0, deleted = 0;
        try {
          for (const f of fs.readdirSync(dir).filter(f => !HIDDEN_FILES.has(f) && !pinned.has(f))) {
            try { const fp = path.join(dir, f); const st = fs.statSync(fp); if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(fp); freed += st.size; deleted++; } } catch {}
          }
        } catch {}
        scheduleRepoSize();
        return { status: 200, body: { deleted, freed } };
      }
    }

    const m = urlPath.match(/^\/api\/chats\/([^/]+)(?:\/(files|stop|export)(?:\/(.+))?)?$/);
    const chatId = m && m[1];
    const subpath = m && m[2];
    const filename = m && m[3] && decodeURIComponent(m[3]);

    if (urlPath === '/api/storage' && method === 'GET')
      return { status: 200, body: { bytes: repoSizeBytes, total: diskTotal, percent: diskTotal ? +(repoSizeBytes / diskTotal * 100).toFixed(2) : 0 } };

    if (urlPath === '/api/chat-order' && method === 'PATCH') {
      if (Array.isArray(body && body.ids)) saveOrder(body.ids);
      return { status: 200, body: { ok: true } };
    }

    if (urlPath === '/api/chats' && method === 'GET') {
      const chats = listChats();
      const order = loadOrder();
      const orderMap = new Map(order.map((id, i) => [id, i]));
      chats.sort((a, b) => {
        const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
        const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
        if (ai === Infinity && bi === Infinity) return b.updatedAt - a.updatedAt;
        if (ai === Infinity) return 1; if (bi === Infinity) return -1;
        return ai - bi;
      });
      const newIds = chats.filter(c => !orderMap.has(c.id)).map(c => c.id);
      if (newIds.length) saveOrder([...order, ...newIds]);
      const list = chats.map(c => ({
        id: c.id, title: c.title, dirName: c.dirName, incognito: c.incognito || false,
        ownerId: resolveOwner(c), updatedAt: c.updatedAt,
        preview: c.messages.at(-1)?.text?.slice(0,80) ?? '',
        isRunning: !!(chatSessions[c.id] && chatSessions[c.id].running),
        runStartTime: chatSessions[c.id]?.startTime || null
      }));
      return { status: 200, body: { chats: list, meta: incognitoStats(chats) } };
    }

    if (urlPath === '/api/chats' && method === 'POST') {
      const incognito = body && body.incognito === true;
      const title = (body && body.title) || ('Chat ' + new Date().toLocaleString());
      const dirName = incognito ? nextIncognitoDirName() : uniqueDirName(sanitizeName(title));
      const chat = { id: uuid(), title, dirName, incognito: incognito || undefined, ownerId: auth.userId, sessionId: null, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      saveChat(chat);
      scheduleRepoSize();
      return { status: 200, body: chat };
    }

    if (chatId && !subpath && method === 'GET') {
      const chat = loadChatById(chatId);
      if (!chat) return { status: 404, body: { error: 'not found' } };
      const sess = chatSessions[chatId];
      return { status: 200, body: { ...chat, ownerId: resolveOwner(chat), isRunning: !!(sess && sess.running), runStartTime: sess?.startTime || null } };
    }

    if (chatId && subpath === 'stop' && method === 'POST') {
      const sess = chatSessions[chatId];
      if (sess && sess.proc) { try { sess.proc.kill('SIGTERM'); } catch {} }
      return { status: 200, body: { ok: true } };
    }

    if (chatId && !subpath && method === 'PATCH') {
      const chat = loadChatById(chatId);
      if (!chat) return { status: 404, body: { error: 'not found' } };
      const owner = resolveOwner(chat);
      if (auth.role !== 'admin' && owner !== auth.userId) return { status: 403, body: { error: 'Forbidden' } };
      if (body && body.title) {
        const newBase = sanitizeName(body.title);
        const newDirName = chat.dirName === newBase ? newBase : uniqueDirName(newBase);
        if (newDirName !== chat.dirName) {
          fs.renameSync(path.join(CHATS, chat.dirName), path.join(CHATS, newDirName));
          chat.dirName = newDirName;
        }
        chat.title = body.title;
      }
      saveChat(chat);
      return { status: 200, body: { ok: true, dirName: chat.dirName } };
    }

    if (chatId && !subpath && method === 'DELETE') {
      const chat = loadChatById(chatId);
      if (chat) {
        const owner = resolveOwner(chat);
        if (auth.role !== 'admin' && owner !== auth.userId) return { status: 403, body: { error: 'Forbidden' } };
        const sess = chatSessions[chatId];
        if (sess && sess.proc) { try { sess.proc.kill('SIGTERM'); } catch {} }
        const chatDir = path.join(CHATS, chat.dirName);
        if (fs.existsSync(chatDir)) fs.rmSync(chatDir, { recursive: true, force: true });
      }
      delete chatSessions[chatId];
      chatCache.delete(chatId);
      broadcast({ type: 'chat_deleted', chatId });
      scheduleRepoSize();
      return { status: 200, body: { ok: true } };
    }

    if (chatId && subpath === 'export' && method === 'GET') {
      // Handled asynchronously in handleRelayMessage / Express route - should not reach here
      return { status: 500, body: { error: 'export must be called async' } };
    }

    if (chatId && subpath === 'files' && !filename && method === 'GET') {
      const chat = loadChatById(chatId);
      if (!chat) return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: getChatFiles(chat) };
    }

    if (chatId && filename && method === 'GET') {
      const chat = loadChatById(chatId);
      if (!chat) return { status: 404, body: { error: 'not found' } };
      const result = readFileForDownload(chat, filename);
      return result ? { status: 200, body: result } : { status: 404, body: { error: 'file not found' } };
    }

    return { status: 404, body: { error: 'unknown route' } };
  } catch(e) { return { status: 500, body: { error: e.message } }; }
}

function handleRelayMessage(msg) {
  if (msg.type === 'api') {
    const auth = getAuthSession(msg.userToken || (msg.body && msg.body.userToken));

    // Export must be handled async (exec, not execSync) and via HTTP /file proxy
    // to avoid sending a multi-MB base64 blob as a single WebSocket frame
    if (msg.method === 'GET' && /\/api\/chats\/[^/]+\/export$/.test(msg.path)) {
      const chatId = msg.path.match(/\/api\/chats\/([^/]+)\/export/)?.[1];
      const chat = chatId && loadChatById(chatId);
      if (!auth) { relayConn.send(JSON.stringify({ type: 'api_response', id: msg.id, body: { error: 'Unauthorized' }, status: 401 })); return; }
      if (!chat) { relayConn.send(JSON.stringify({ type: 'api_response', id: msg.id, body: { error: 'not found' }, status: 404 })); return; }
      const conn = relayConn;
      console.log('[export] starting zip for chat:', chat.id);
      exportChatZipToFile(chat)
        .then(({ zipName, filename }) => {
          console.log('[export] zip ready:', zipName);
          conn.send(JSON.stringify({ type: 'api_response', id: msg.id, body: { chatDownload: { chatId: chat.id, filename: zipName, realFilename: filename } }, status: 200 }));
        })
        .catch(e => {
          console.error('[export] error:', e.message);
          conn.send(JSON.stringify({ type: 'api_response', id: msg.id, body: { error: 'Export failed: ' + e.message }, status: 500 }));
        });
      return;
    }

    const r = handleApiMsg(msg.method, msg.path, msg.body, auth);
    relayConn.send(JSON.stringify({ type: 'api_response', id: msg.id, body: r.body, status: r.status }));
    return;
  }
  if (msg.type === 'download_start') {
    const auth = getAuthSession(msg.userToken);
    const conn = relayConn;
    const sendErr = (err) => { if (conn && conn.readyState === 1) conn.send(JSON.stringify({ type: 'download_chunk', id: msg.id, error: err, final: true })); };
    if (!auth) { sendErr('Unauthorized'); return; }
    const chat = loadChatById(msg.chatId);
    if (!chat) { sendErr('Chat not found'); return; }
    const filePath = path.join(CHATS, chat.dirName, path.basename(msg.filename));
    if (!fs.existsSync(filePath)) { sendErr('File not found'); return; }
    const ext  = path.extname(msg.filename).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const CHUNK = 256 * 1024; // 256 KB binary per frame
    let seq = 0;
    const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK });
    stream.on('data', chunk => {
      stream.pause();
      if (!conn || conn.readyState !== 1) { stream.destroy(); return; }
      conn.send(JSON.stringify({ type: 'download_chunk', id: msg.id, seq: seq++, data: chunk.toString('base64'), mime, final: false }), () => stream.resume());
    });
    stream.on('end', () => {
      if (conn && conn.readyState === 1)
        conn.send(JSON.stringify({ type: 'download_chunk', id: msg.id, seq: seq++, data: '', mime, final: true }));
    });
    stream.on('error', e => sendErr(e.message));
    return;
  }
  if (msg.type === 'join') return;
  if (msg.type === 'input' && msg.chatId) {
    const auth = getAuthSession(msg.userToken || (msg.body && msg.body.userToken));
    if (!auth) return;
    const text = msg.data.replace(/\n$/, '');
    const chat = loadChatById(msg.chatId);
    if (chat) {
      const owner = resolveOwner(chat);
      if (auth.role !== 'admin' && owner !== auth.userId) return;
      appendMessage(chat, 'user', text);
    }
    runClaudeMessage(msg.chatId, text);
    return;
  }
  if (msg.type === 'upload' && msg.chatId) {
    const auth = getAuthSession(msg.userToken || (msg.body && msg.body.userToken));
    if (!auth) return;
    try {
      const chat = loadChatById(msg.chatId);
      if (!chat) return;
      const owner = resolveOwner(chat);
      if (auth.role !== 'admin' && owner !== auth.userId) return;
      const filename = msg.filename;
      const dest = path.join(CHATS, chat.dirName, filename);
      fs.writeFileSync(dest, Buffer.from(msg.b64, 'base64'));
      const prompt = (msg.message ? msg.message + '\n' : '') + 'The user uploaded a file. It is saved as: ' + filename + ' (in your current directory). Please read and process it.';
      appendMessage(chat, 'user', msg.message || msg.filename);
      runClaudeMessage(msg.chatId, prompt);
    } catch(e) { console.error('upload error:', e.message); }
  }
  if (msg.type === 'multi_upload' && msg.chatId) {
    const auth = getAuthSession(msg.userToken || (msg.body && msg.body.userToken));
    if (!auth) return;
    try {
      const chat = loadChatById(msg.chatId);
      if (!chat) return;
      const owner = resolveOwner(chat);
      if (auth.role !== 'admin' && owner !== auth.userId) return;
      const saved = [];
      for (const f of (msg.files || [])) {
        let filename = f.filename;
        const chatDir = path.join(CHATS, chat.dirName);
        // Deduplicate: if file already exists, append _1, _2, etc.
        if (fs.existsSync(path.join(chatDir, filename))) {
          const ext = path.extname(filename);
          const base = path.basename(filename, ext);
          let i = 1;
          while (fs.existsSync(path.join(chatDir, `${base}_${i}${ext}`))) i++;
          filename = `${base}_${i}${ext}`;
        }
        fs.writeFileSync(path.join(chatDir, filename), Buffer.from(f.b64, 'base64'));
        saved.push({ filename, isImage: f.isImage });
      }
      const fileList = saved.map(f => `  - ${f.filename}`).join('\n');
      const prompt = (msg.message ? msg.message + '\n\n' : '') +
        `The user attached ${saved.length} file(s), saved in your current directory:\n${fileList}`;
      appendMessage(chat, 'user', msg.message || `[Attached ${saved.length} file(s)]`, saved);
      runClaudeMessage(msg.chatId, prompt);
    } catch(e) { console.error('multi_upload error:', e.message); }
  }
}

function connectRelay() {
  if (!RELAY_URL || !RELAY_TOKEN) return;
  const url = RELAY_URL.replace(/\/$/, '') + '/ws?token=' + RELAY_TOKEN + '&role=host';
  relayConn = new WS(url);
  let pingInterval = null;
  let pongTimeout = null;
  relayConn.on('open', () => {
    console.log('relay connected:', RELAY_URL);
    pingInterval = setInterval(() => {
      if (relayConn && relayConn.readyState === WS.OPEN) {
        relayConn.ping();
        pongTimeout = setTimeout(() => {
          console.log('relay pong timeout (network change?), reconnecting...');
          if (relayConn) relayConn.terminate();
        }, 5000);
      }
    }, 8000);
  });
  relayConn.on('pong', () => {
    clearTimeout(pongTimeout);
    pongTimeout = null;
  });
  relayConn.on('error', err => console.error('relay error:', err.message));
  relayConn.on('close', () => {
    console.log('relay disconnected, retrying...');
    clearInterval(pingInterval);
    clearTimeout(pongTimeout);
    relayConn = null;
    setTimeout(connectRelay, 1000);
  });
  relayConn.on('message', raw => { try { handleRelayMessage(JSON.parse(raw)); } catch(e) { console.error('relay msg error:', e.message); } });
}
