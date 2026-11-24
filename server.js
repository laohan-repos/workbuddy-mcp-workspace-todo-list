/**
 * 待办清单服务端
 * 零依赖：仅使用 Node.js 原生模块（http / fs / path / crypto）
 * 启动：node server.js   默认 http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'todos.json');

/* ------------------------- 数据层 ------------------------- */

let todos = [];

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      todos = parsed.filter((t) => t && typeof t.title === 'string');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('读取数据失败：', err.message);
    todos = [];
  }
}

// 数据量很小，直接同步落盘，保证不丢数据
function saveData() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(todos, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE); // 原子替换，避免写一半损坏文件
}

/* ------------------------- 实时推送（SSE） ------------------------- */

const sseClients = new Set();

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const client = { res };
  sseClients.add(client);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
}

// 把变更广播给所有打开的页面：MCP / 命令行 / 其他标签页都能实时看到
function broadcast(payload) {
  if (sseClients.size === 0) return;
  const frame = `data: ${JSON.stringify({ ...payload, at: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

// 变更来源：浏览器传 ui，MCP 传 mcp
function getSource(req) {
  return req.headers['x-client'] || 'unknown';
}

// 每个标签页有独立的 client id，用于「忽略自己触发的回声」
function notify(req, payload) {
  broadcast({
    type: 'todos:changed',
    source: getSource(req),
    originId: req.headers['x-client-id'] || null,
    ...payload,
  });
}

/* ------------------------- 工具函数 ------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeTitle(input) {
  if (typeof input !== 'string') return null;
  const title = input.trim().replace(/\s+/g, ' ');
  if (!title || title.length > 200) return null;
  return title;
}

/* ------------------------- API 路由 ------------------------- */

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api','todos',id?]
  const id = segments[2];

  // GET /api/todos —— 列出全部
  if (req.method === 'GET' && !id) {
    return sendJson(res, 200, todos);
  }

  // POST /api/todos —— 新增
  if (req.method === 'POST' && !id) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    const title = sanitizeTitle(body.title);
    if (!title) return sendJson(res, 400, { error: 'title 不能为空且不超过 200 字符' });

    const todo = {
      id: crypto.randomUUID(),
      title,
      done: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    todos.unshift(todo);
    saveData();
    notify(req, { action: 'add', todo });
    return sendJson(res, 201, todo);
  }

  // DELETE /api/todos?done=true —— 清除已完成
  if (req.method === 'DELETE' && !id) {
    if (url.searchParams.get('done') === 'true') {
      const before = todos.length;
      todos = todos.filter((t) => !t.done);
      saveData();
      notify(req, { action: 'clear', removed: before - todos.length });
      return sendJson(res, 200, { removed: before - todos.length, todos });
    }
    return sendJson(res, 400, { error: '缺少参数，或使用 DELETE /api/todos/:id' });
  }

  if (id) {
    const index = todos.findIndex((t) => t.id === id);

    // PATCH /api/todos/:id —— 更新标题或完成状态
    if (req.method === 'PATCH') {
      if (index === -1) return sendJson(res, 404, { error: '待办不存在' });
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }

      const next = { ...todos[index] };
      if ('title' in body) {
        const title = sanitizeTitle(body.title);
        if (!title) return sendJson(res, 400, { error: 'title 非法' });
        next.title = title;
      }
      if ('done' in body) next.done = Boolean(body.done);
      next.updatedAt = new Date().toISOString();

      todos[index] = next;
      saveData();
      notify(req, { action: 'update', todo: next });
      return sendJson(res, 200, next);
    }

    // DELETE /api/todos/:id —— 删除单条
    if (req.method === 'DELETE') {
      if (index === -1) return sendJson(res, 404, { error: '待办不存在' });
      const [removed] = todos.splice(index, 1);
      saveData();
      notify(req, { action: 'delete', todo: removed });
      return sendJson(res, 200, removed);
    }
  }

  return sendJson(res, 405, { error: '不支持的请求方法' });
}

/* ------------------------- 静态资源 ------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);

  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendText(res, 403, 'Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, '404 Not Found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------- 启动 ------------------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/events') {
    if (req.method !== 'GET') return sendText(res, 405, 'Method Not Allowed');
    return handleEvents(req, res);
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('接口异常：', err);
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }
  serveStatic(req, res, url);
});

loadData();
server.listen(PORT, () => {
  console.log(`✅ Todo 服务已启动： http://localhost:${PORT}`);
  console.log(`   数据文件： ${DATA_FILE}`);
});

process.on('SIGINT', () => {
  saveData();
  server.close(() => process.exit(0));
});
