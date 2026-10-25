/**
 * MarsOJ manager API client.
 *
 * The manager API is a JSON API behind a `sid` header. This module is shared by
 * the scraper, the raw-event fetcher and ad-hoc scripts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

try {
  process.loadEnvFile?.();
} catch {
  // .env is optional in CI; Actions provides environment variables.
}

export const MANAGER_BASE = 'https://ms.marsoj.cn';
export const MANAGER_ORIGIN = 'https://manager.marsoj.cn';
const USER_AGENT = 'Mozilla/5.0';

export function getCredentials() {
  const username = process.env.MARS_USER;
  const password = process.env.MARS_PASS;
  if (!username || !password) throw new Error('缺少 MARS_USER / MARS_PASS，请配置 .env 或环境变量');
  return { username, password };
}

export class ManagerClient {
  constructor({ concurrency = 4 } = {}) {
    this.sid = '';
    this.concurrency = concurrency;
  }

  async login() {
    const { username, password } = getCredentials();
    const response = await fetch(`${MANAGER_BASE}/api/user/loginWithAccount`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: MANAGER_ORIGIN,
        Referer: `${MANAGER_ORIGIN}/`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ uname: username, password }),
    });
    const json = await response.json();
    if (!json?.data?.sid) throw new Error(`管理端登录失败：${json?.message || response.status}`);
    this.sid = json.data.sid;
    return this.sid;
  }

  async post(endpoint, body = {}, { retry = true } = {}) {
    if (!this.sid) await this.login();
    const response = await fetch(`${MANAGER_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: MANAGER_ORIGIN,
        Referer: `${MANAGER_ORIGIN}/`,
        sid: this.sid,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(60000),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`接口返回非 JSON：${endpoint} (${response.status})`);
    }
    if (json?.code === 401 && retry) {
      await this.login();
      return this.post(endpoint, body, { retry: false });
    }
    if (json?.code !== 0) throw new Error(json?.message || `接口错误 ${endpoint}`);
    return json.data;
  }

  async listHomeworks(keyword = '高潜') {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.post('/api/homework/getList', { page, pageSize: 50, keyword });
      const list = data?.list || [];
      all.push(...list);
      if (list.length < 50) break;
      if (data?.total && all.length >= Number(data.total)) break;
    }
    return all;
  }

  async getHomeworkInfo(id) {
    return this.post('/api/homework/getInfo', { _id: id });
  }

  async getScoreboard(id) {
    return this.post('/api/homework/getScoreboard', { _id: id });
  }

  /**
   * Full submission list for one problem, ordered by record `_id` (ascending).
   * The endpoint rejects pageSize > 50 and silently ignores uid filters, so we
   * locate the cutoff page with a binary search and page forward from there.
   */
  async getProblemRecords(problemId, { page = 1, pageSize = 50 } = {}) {
    return this.post('/api/problem/getRefRecordList', { _id: problemId, page, pageSize });
  }

  /**
   * Records are ordered by record id (creation time), so the term cutoff sits
   * near the last pages. Walking backward from the last page is cheaper than a
   * binary search: usually 1-4 requests per problem.
   */
  async getProblemRecordsSince(problemId, cutoffMs, { maxPages = 80 } = {}) {
    const first = await this.getProblemRecords(problemId, { page: 1 });
    const total = Number(first?.total || 0);
    if (!total) return [];
    const pageSize = 50;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    const tsOf = (record) => parseInt(String(record._id).slice(0, 8), 16) * 1000;

    const last = lastPage === 1 ? first : await this.getProblemRecords(problemId, { page: lastPage, pageSize });
    const lastList = last?.list || [];
    if (!lastList.length || tsOf(lastList[lastList.length - 1]) < cutoffMs) return [];

    const collected = [];
    let page = lastPage;
    let data = last;
    for (let step = 0; step < maxPages && page >= 1; step++) {
      const list = data?.list || [];
      if (!list.length) break;
      collected.unshift(...list);
      if (tsOf(list[0]) < cutoffMs) break;
      page--;
      if (page < 1) break;
      data = await this.getProblemRecords(problemId, { page, pageSize });
    }
    return collected.filter((r) => tsOf(r) >= cutoffMs);
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

  async requestCodeZip(homeworkId) {
    const data = await this.post('/api/homework/getCodeZip', { _id: homeworkId });
    return data?.task || null;
  }

  async getDownloadTask(taskId) {
    const data = await this.post('/api/downloadTask/getList', { page: 1, pageSize: 50 });
    return (data?.list || []).find((t) => t._id === taskId) || null;
  }

  async waitDownloadUrl(taskId, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await this.getDownloadTask(taskId);
      if (task?.status === 2 && task.url) return task.url;
      if (task?.status === 3) throw new Error(task.errMsg || '代码包生成失败');
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}
