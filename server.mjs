import http from 'node:http';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  scrapeAll,
  loadSnapshot,
  checkNewHomeworks,
  paths,
} from './scraper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 43130);
const HOST = process.env.HOST || '127.0.0.1';
const AUTO_CHECK_MS = Number(process.env.AUTO_CHECK_MS || 5 * 60 * 1000);

let snapshot = await loadSnapshot();
const state = {
  running: false,
  progress: null,
  error: null,
  lastCheck: null,
  newHomeworks: [],
  autoCheck: true,
};

const clients = new Set();

function sendEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.write(payload); } catch { clients.delete(client); }
  }
}

function publicState() {
  return {
    hasData: Boolean(snapshot),
    generatedAt: snapshot?.generatedAt || null,
    stats: snapshot?.stats || null,
    running: state.running,
    progress: state.progress,
    error: state.error,
    lastCheck: state.lastCheck,
    newHomeworks: state.newHomeworks,
    autoCheck: state.autoCheck,
  };
}

async function runScrape(force = false) {
  if (state.running) return false;
  state.running = true;
  state.error = null;
  state.progress = { phase: 'starting', message: '准备抓取…', current: 0, total: 0 };
  sendEvent('progress', state.progress);

  try {
    const result = await scrapeAll({
      force,
      onProgress: (progress) => {
        state.progress = progress;
        sendEvent('progress', progress);
      },
    });
    snapshot = result;
    state.newHomeworks = [];
    sendEvent('done', { generatedAt: result.generatedAt, stats: result.stats });
    return true;
  } catch (error) {
    state.error = error.message || String(error);
    sendEvent('error', { message: state.error });
    return false;
  } finally {
    state.running = false;
    state.progress = null;
  }
}

async function runCheck() {
  if (state.running) return null;
  try {
    const result = await checkNewHomeworks();
    state.lastCheck = result.checkedAt;
    if (result.newCount > 0) {
      state.newHomeworks = result.newHomeworks;
      sendEvent('new-homeworks', result);
    } else {
      state.newHomeworks = [];
    }
    sendEvent('check', result);
    return result;
  } catch (error) {
    sendEvent('check-error', { message: error.message });
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]);
  const relative = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not file');
    const ext = path.extname(filePath).toLowerCase();
    const isVendor = filePath.includes(`${path.sep}vendor${path.sep}`);
    const noCache = ['.html', '.js', '.css'].includes(ext) && !isVendor;
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    try {
      const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/state') return json(res, 200, publicState());

  if (pathname === '/api/data') {
    if (!snapshot) return json(res, 404, { error: '暂无数据，请先抓取' });
    return json(res, 200, snapshot);
  }

  if (pathname === '/api/diagnosis') {
    try {
      const text = await fs.readFile(path.join(__dirname, 'data', 'diagnosis.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(text);
    } catch {
      return json(res, 404, { error: '尚未生成诊断，请先运行 npm run analyze' });
    }
  }

  if (pathname === '/api/check') {
    const result = await runCheck();
    return json(res, result ? 200 : 503, result || { error: '检测失败' });
  }

  if (pathname === '/api/scrape' && req.method === 'POST') {
    if (state.running) return json(res, 409, { error: '抓取正在进行中' });
    const body = await readBody(req);
    runScrape(Boolean(body.force));
    return json(res, 202, { started: true });
  }

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (pathname === '/api/health') {
    return json(res, 200, { ok: true, uptime: process.uptime() });
  }

  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`高潜作业学情看板已启动: http://${HOST}:${PORT}`);
  if (AUTO_CHECK_MS > 0) {
    setTimeout(() => {
      runCheck();
      setInterval(() => { if (!state.running) runCheck(); }, AUTO_CHECK_MS);
    }, 4000);
  }
});
