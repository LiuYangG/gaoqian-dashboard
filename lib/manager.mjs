/**
 * MarsOJ client for the post-2026 unified deployment.
 *
 * The old `ms.marsoj.cn` / `manager.marsoj.cn` API is gone. The manager UI is
 * served from https://marsoj.cn/manager and talks to `/api/manager/v1/...`
 * behind the same SSO cookie as the student site.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

try { process.loadEnvFile?.(); } catch { /* optional */ }

export const BASE_URL = 'https://marsoj.cn';
const UA = 'Mozilla/5.0';

export function getCredentials() {
  const username = process.env.MARS_USER;
  const password = process.env.MARS_PASS;
  if (!username || !password) throw new Error('缺少 MARS_USER / MARS_PASS，请配置 .env 或环境变量');
  return { username, password };
}

export class CookieJar {
  constructor() { this.cookies = new Map(); }
  absorb(response) {
    for (const line of (response.headers.getSetCookie ? response.headers.getSetCookie() : [])) {
      const pair = line.split(';')[0];
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      // SSO login sets a domain cookie and immediately clears a same-name host
      // cookie; keep the real value instead of the clearing entry.
      if (value) this.cookies.set(name, value);
    }
  }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  clear() { this.cookies.clear(); }
}

export class ManagerClient {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = concurrency;
    this.jar = new CookieJar();
    this.session = null;
  }

  async login() {
    const { username, password } = getCredentials();
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.jar.clear();
      let response = await fetch(`${BASE_URL}/login`, { headers: { 'User-Agent': UA }, redirect: 'manual' });
      this.jar.absorb(response);
      await response.text();
      response = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: this.jar.header(),
          Referer: `${BASE_URL}/login`,
          'User-Agent': UA,
        },
        body: new URLSearchParams({ uname: username, password, rememberme: 'on' }),
        redirect: 'manual',
      });
      this.jar.absorb(response);
      lastStatus = response.status;
      if (response.status === 302 || response.status === 200) break;
      // The SSO endpoint rate-limits bursts of logins; back off and retry.
      if ((response.status === 403 || response.status === 429) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
        continue;
      }
      throw new Error(`登录失败：HTTP ${response.status}`);
    }
    if (lastStatus !== 302 && lastStatus !== 200) throw new Error(`登录失败：HTTP ${lastStatus}`);
    const session = await this.get('/api/manager/v1/session', { accept: 'json' });
    if (!session?.authenticated) throw new Error('登录后管理端会话未通过验证');
    this.session = session;
    return session;
  }

  async get(pathname, { accept = 'json', retry = true } = {}) {
    if (!this.jar.cookies.size) await this.login();
    const response = await fetch(BASE_URL + pathname, {
      headers: {
        Cookie: this.jar.header(),
        'User-Agent': UA,
        Accept: accept === 'json' ? 'application/json' : 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
    });
    if (response.status === 401 && retry) {
      await this.login();
      return this.get(pathname, { accept, retry: false });
    }
    if (response.status === 302) {
      const location = response.headers.get('location') || '';
      if (location.includes('/login') && retry) {
        await this.login();
        return this.get(pathname, { accept, retry: false });
      }
    }
    if (!response.ok) throw new Error(`请求失败 ${pathname}: HTTP ${response.status}`);
    const text = await response.text();
    if (accept === 'json') {
      try { return JSON.parse(text); } catch { throw new Error(`接口返回非 JSON：${pathname}`); }
    }
    return text;
  }

  async listHomeworks({ q = '高潜', history = 'all', pageSize = 50 } = {}) {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), q, history });
      const data = await this.get(`/api/manager/v1/homeworks?${params}`);
      const items = data?.items || [];
      all.push(...items);
      if (!data?.nextPage || items.length < pageSize) break;
    }
    return all;
  }

  async getHomework(tid) {
    return this.get(`/api/manager/v1/homeworks/${encodeURIComponent(tid)}`);
  }

  async getScoreboardHtml(tid) {
    return this.get(`/homework/${encodeURIComponent(tid)}/scoreboard`, { accept: 'html' });
  }

  async getRecordListHtml(tid, page = 1) {
    const suffix = page > 1 ? `&page=${page}` : '';
    return this.get(`/record?tid=${encodeURIComponent(tid)}${suffix}`, { accept: 'html' });
  }

  async getRecordDetailHtml(rid) {
    return this.get(`/record/${encodeURIComponent(rid)}`, { accept: 'html' });
  }

  async getProblemRecords(docId, { page = 1, pageSize = 100 } = {}) {
    return this.get(`/api/manager/v1/problems/${encodeURIComponent(String(docId))}/references/records?page=${page}&pageSize=${pageSize}`);
  }

  async mapLimit(items, worker) {
    let cursor = 0;
    const results = new Array(items.length);
    const runners = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) break;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return results;
  }
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}
