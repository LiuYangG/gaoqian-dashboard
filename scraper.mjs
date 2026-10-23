import { promises as fs } from 'node:fs';
import path from 'node:path';

try {
  process.loadEnvFile?.();
} catch {
  // .env is optional locally; GitHub Actions provides the variables directly.
}

function getCredentials() {
  const username = process.env.MARS_USER;
  const password = process.env.MARS_PASS;
  if (!username || !password) {
    throw new Error('缺少 MARS_USER / MARS_PASS，请配置 .env 或环境变量');
  }
  return { username, password };
}

const MANAGER_BASE = 'https://ms.marsoj.cn';
const MANAGER_ORIGIN = 'https://manager.marsoj.cn';
const STUDENT_BASE = 'https://marsoj.cn';
const KEYWORD = '高潜';
const TITLE_RE = /高潜\s*0*(\d+)/;
const CONCURRENCY = Number(process.env.MARS_CONCURRENCY || 6);

const DATA_DIR = path.resolve('data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const KNOWN_FILE = path.join(DATA_DIR, 'known-homeworks.json');
const CACHE_FILE = path.join(DATA_DIR, 'record-cache.json');

const STATUS_MAP = {
  accepted: { code: 'AC', label: '通过', tone: 'ac' },
  'wrong answer': { code: 'WA', label: '答案错误', tone: 'fail' },
  'time limit exceeded': { code: 'TLE', label: '超时', tone: 'fail' },
  'memory limit exceeded': { code: 'MLE', label: '超内存', tone: 'fail' },
  'runtime error': { code: 'RE', label: '运行错误', tone: 'fail' },
  'compile error': { code: 'CE', label: '编译错误', tone: 'fail' },
  'system error': { code: 'SE', label: '系统错误', tone: 'fail' },
  'output limit exceeded': { code: 'OLE', label: '输出超限', tone: 'fail' },
  'judgement failed': { code: 'JF', label: '评测失败', tone: 'fail' },
  'invalid interaction': { code: 'IE', label: '交互错误', tone: 'fail' },
  'partially correct': { code: 'PC', label: '部分正确', tone: 'warn' },
  pending: { code: 'PD', label: '等待评测', tone: 'warn' },
  judging: { code: 'JG', label: '评测中', tone: 'warn' },
  'compiling': { code: 'CP', label: '编译中', tone: 'warn' },
  'fetched': { code: 'FD', label: '已取回', tone: 'warn' },
};

class CookieJar {
  constructor() { this.cookies = new Map(); }
  absorb(response) {
    const list = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const line of list) {
      const pair = line.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear() { this.cookies.clear(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeHtml(input = '') {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html = '') {
  return decodeHtml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeStatus(raw = '') {
  const key = raw.trim().toLowerCase();
  return STATUS_MAP[key] || { code: raw.trim().slice(0, 8) || 'UNK', label: raw.trim() || '未知', tone: 'warn' };
}

function parseDlPairs(block) {
  const out = {};
  const dtRe = /<dt[^>]*>([\s\S]*?)<\/dt>/gi;
  const matches = [...block.matchAll(dtRe)];
  for (let i = 0; i < matches.length; i++) {
    const label = stripTags(matches[i][1]);
    const start = (matches[i].index || 0) + matches[i][0].length;
    const next = i + 1 < matches.length ? matches[i + 1].index : block.indexOf('</dl>', start);
    let segment = block.slice(start, next >= 0 ? next : block.length);
    segment = segment
      .replace(/^\s*<dd[^>]*>/i, '')
      .replace(/<\/dd>\s*$/i, '')
      .replace(/<\/dt>\s*$/i, '')
      .trim();
    if (label && segment) out[label] = segment;
  }
  return out;
}

function parseTimestampSpan(html) {
  const m = html.match(/<span class="time[^"]*"[^>]*data-timestamp="([\d.]+)"[^>]*>([\s\S]*?)<\/span>/);
  if (!m) return { iso: '', text: stripTags(html), ts: 0 };
  const ts = Number(m[1]);
  return { iso: new Date(ts * 1000).toISOString(), text: stripTags(m[2]), ts };
}

export function parseRecordHtml(html, rid) {
  const statusMatch = html.match(/<span class="record-status--text ([^"]+)">\s*([^<]+?)\s*<\/span>/);
  const status = normalizeStatus(statusMatch ? statusMatch[2] : '');

  const summaryBlock = (html.match(/<dl[^>]*id="summary"[^>]*>([\s\S]*?)<\/dl>/) || [])[1] || '';
  const summary = parseDlPairs(summaryBlock);

  const infoStart = html.indexOf('section__title">信息');
  const infoBlock = infoStart >= 0 ? html.slice(infoStart) : html;
  const infoDl = (infoBlock.match(/<dl class="large horizontal">([\s\S]*?)<\/dl>/) || [])[1] || '';
  const info = parseDlPairs(infoDl);

  const codeMatch = html.match(/<pre class="line-numbers"><code[^>]*>([\s\S]*?)<\/code><\/pre>/);
  const code = codeMatch ? decodeHtml(codeMatch[1]).replace(/\r\n/g, '\n') : '';

  const userMatch = infoBlock.match(/<a class="user-profile-name[^"]*" href="\/user\/(\d+)">\s*([\s\S]*?)<\/a>/);
  const problemMatch = infoBlock.match(/<a href="\/p\/([^"?]+)\?[^"]*"><b>([^<]+)<\/b>\s*&nbsp;&nbsp;([\s\S]*?)<\/a>/);
  const homeworkMatch = infoBlock.match(/<dt>作业<\/dt>\s*<dd>\s*<a[^>]*>([\s\S]*?)<\/a>/);

  const submit = parseTimestampSpan((info['递交时间'] || ''));
  const judge = parseTimestampSpan((info['评测时间'] || ''));

  const caseBlock = (html.match(/<table class="data-table record_detail__table">([\s\S]*?)<\/table>/) || [])[1] || '';
  const cases = [];
  const caseRe = /<tr class="subtask-case">([\s\S]*?)<\/tr>/g;
  let cm;
  while ((cm = caseRe.exec(caseBlock))) {
    const row = cm[1];
    const st = row.match(/<span class="record-status--text ([^"]+)">\s*([^<]+?)\s*<\/span>/);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => stripTags(x[1]));
    cases.push({
      status: st ? normalizeStatus(st[2]) : null,
      time: cells[2] || '',
      memory: cells[3] || '',
    });
  }

  return {
    rid,
    status,
    score: Number((summary['分数'] || '0').replace(/[^\d.-]/g, '')) || 0,
    totalTime: stripTags(summary['总耗时'] || ''),
    peakTime: stripTags(summary['峰值时间'] || ''),
    peakMemory: stripTags(summary['峰值内存'] || ''),
    language: stripTags(info['语言'] || ''),
    codeLength: stripTags(info['代码长度'] || ''),
    submitAt: submit.iso,
    submitText: submit.text,
    judgeAt: judge.iso,
    judgeText: judge.text,
    user: userMatch ? { uid: Number(userMatch[1]), name: stripTags(userMatch[2]) } : null,
    problem: problemMatch ? { pid: stripTags(problemMatch[1]), name: stripTags(problemMatch[3]) } : null,
    homework: homeworkMatch ? stripTags(homeworkMatch[1]) : '',
    code,
    cases,
  };
}

async function managerLogin() {
  const { username, password } = getCredentials();
  const response = await fetch(`${MANAGER_BASE}/api/user/loginWithAccount`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: MANAGER_ORIGIN,
      Referer: `${MANAGER_ORIGIN}/`,
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({ uname: username, password }),
  });
  const json = await response.json();
  if (!json?.data?.sid) throw new Error(`管理端登录失败：${json?.message || response.status}`);
  return json.data.sid;
}

async function managerPost(sid, endpoint, body) {
  const response = await fetch(`${MANAGER_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: MANAGER_ORIGIN,
      Referer: `${MANAGER_ORIGIN}/`,
      sid,
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify(body || {}),
  });
  const json = await response.json();
  if (json?.code !== 0) throw new Error(json?.message || `接口错误 ${endpoint}`);
  return json.data;
}

async function hydroLogin(jar) {
  const { username, password } = getCredentials();
  jar.clear();
  let response = await fetch(`${STUDENT_BASE}/login`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  jar.absorb(response);
  const html = await response.text();
  const csrf = (html.match(/name="csrfToken" value="([^"]+)"/) || [])[1];
  if (!csrf) throw new Error('学员端登录页未找到 csrfToken');
  response = await fetch(`${STUDENT_BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header(),
      Referer: `${STUDENT_BASE}/login`,
      'User-Agent': 'Mozilla/5.0',
    },
    body: new URLSearchParams({ uname: username, password, csrfToken: csrf }),
    redirect: 'manual',
  });
  jar.absorb(response);
  if (response.status !== 302 && response.status !== 200) throw new Error(`学员端登录失败：${response.status}`);
}

async function fetchRecord(jar, rid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${STUDENT_BASE}/new/record/${rid}`, {
        headers: { Cookie: jar.header(), 'User-Agent': 'Mozilla/5.0' },
        redirect: 'manual',
      });
      if (response.status === 302) {
        const location = response.headers.get('location') || '';
        if (location.includes('/login')) {
          await hydroLogin(jar);
          continue;
        }
      }
      if (response.status === 404) return { rid, missing: true, error: '记录不存在' };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (html.includes('data-page="user_login"')) {
        await hydroLogin(jar);
        continue;
      }
      return parseRecordHtml(html, rid);
    } catch (error) {
      if (attempt === 2) return { rid, error: error.message };
      await sleep(400 * (attempt + 1));
    }
  }
  return { rid, error: '抓取失败' };
}

async function mapLimit(items, limit, worker, onProgress) {
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      await worker(items[index], index);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
}

async function fetchAllHomeworks(sid) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const data = await managerPost(sid, '/api/homework/getList', {
      page,
      pageSize: 50,
      keyword: KEYWORD,
    });
    const list = data?.list || [];
    all.push(...list);
    if (list.length < 50) break;
    if (data?.total && all.length >= Number(data.total)) break;
  }
  return all;
}

function parseHomeworkList(list) {
  return list
    .filter((item) => TITLE_RE.test(item.title))
    .map((item) => {
      const match = item.title.match(TITLE_RE);
      return { ...item, order: Number(match[1]) };
    })
    .sort((a, b) => a.order - b.order);
}

function parseScoreboard(data) {
  const rows = data?.rows || [];
  if (rows.length < 1) return { problems: [], students: [] };
  const header = rows[0];
  const problems = header.slice(4).map((cell) => ({
    docId: cell.raw,
    pid: String(cell.value || '').replace(/^#/, ''),
  }));
  const students = rows.slice(1).map((row) => {
    const userCell = row.find((cell) => cell.type === 'user');
    const recordCells = row.slice(4);
    return {
      uid: Number(userCell?.raw || 0),
      name: userCell?.value || '未知学员',
      rank: Number(row[0]?.value) || 0,
      totalScore: Number(row[2]?.value) || 0,
      totalTime: String(row[3]?.value || ''),
      cells: recordCells.map((cell, index) => ({
        docId: problems[index]?.docId ?? null,
        pid: problems[index]?.pid ?? '',
        status: cell.type === 'record'
          ? (cell.isAc ? 'ac' : (cell.isSubmit ? 'attempted' : 'none'))
          : 'none',
        score: Number(cell.score || 0),
        isAc: Boolean(cell.isAc),
        isSubmit: Boolean(cell.isSubmit),
        rid: cell.type === 'record' ? (cell.raw || '') : '',
        value: cell.value || '',
      })),
    };
  });
  return { problems, students };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

export async function listHomeworkTitles() {
  const sid = await managerLogin();
  const list = await fetchAllHomeworks(sid);
  return parseHomeworkList(list).map((h) => ({
    id: h._id,
    title: h.title,
    classid: h.classid,
    beginAt: h.beginAt,
    penaltySince: h.penaltySince,
    order: h.order,
  }));
}

export async function checkNewHomeworks() {
  const known = await readJson(KNOWN_FILE, {});
  const list = await listHomeworkTitles();
  const initialized = Object.keys(known).length > 0;
  const fresh = initialized ? list.filter((h) => !known[h.id]) : [];
  return {
    total: list.length,
    known: Object.keys(known).length,
    initialized,
    newCount: fresh.length,
    newHomeworks: fresh,
    checkedAt: new Date().toISOString(),
  };
}

export async function scrapeAll({ onProgress = () => {}, force = false } = {}) {
  const startedAt = new Date().toISOString();
  const emit = (phase, message, current = 0, total = 0, extra = {}) => {
    onProgress({ phase, message, current, total, startedAt, ...extra });
  };

  emit('login', '正在登录管理端…');
  const sid = await managerLogin();

  emit('list', '正在检索“高潜”作业…');
  const list = await fetchAllHomeworks(sid);
  const homeworks = parseHomeworkList(list);
  if (!homeworks.length) throw new Error('未检索到“高潜”作业');

  const known = await readJson(KNOWN_FILE, {});
  const isFirstRun = Object.keys(known).length === 0;
  const now = new Date().toISOString();
  const homeworkDetails = [];

  for (let i = 0; i < homeworks.length; i++) {
    const hw = homeworks[i];
    emit('homework', `读取作业：${hw.title}`, i, homeworks.length);
    let info;
    let scoreboard;
    try {
      info = await managerPost(sid, '/api/homework/getInfo', { _id: hw._id });
      scoreboard = await managerPost(sid, '/api/homework/getScoreboard', { _id: hw._id });
    } catch (error) {
      homeworkDetails.push({
        id: hw._id,
        title: hw.title,
        classid: hw.classid,
        beginAt: hw.beginAt,
        endAt: hw.penaltySince,
        order: hw.order,
        error: error.message,
        problems: [],
        students: [],
        firstSeenAt: known[hw._id]?.firstSeenAt || now,
        isNew: !isFirstRun && !known[hw._id],
      });
      continue;
    }

    const metaProblems = info?.problems || [];
    const problemMap = new Map(metaProblems.map((p) => [p.docId, p]));
    const parsed = parseScoreboard(scoreboard);

    const problems = parsed.problems.map((p) => {
      const meta = problemMap.get(p.docId);
      return {
        docId: p.docId,
        pid: meta?.pid || p.pid,
        title: meta?.title || p.pid || `题目 #${p.docId}`,
      };
    });

    const students = parsed.students.map((student) => ({
      ...student,
      cells: student.cells.map((cell) => {
        const problem = problems.find((p) => p.docId === cell.docId);
        return { ...cell, pid: cell.pid || problem?.pid || '', title: problem?.title || '' };
      }),
    }));

    homeworkDetails.push({
      id: hw._id,
      title: hw.title,
      classid: hw.classid,
      beginAt: hw.beginAt,
      endAt: hw.penaltySince,
      order: hw.order,
      problemCount: problems.length,
      problems,
      students,
      noData: students.length === 0,
      firstSeenAt: known[hw._id]?.firstSeenAt || now,
      isNew: !isFirstRun && !known[hw._id],
      sourceUrl: `https://marsoj.cn/school/homework/${hw._id}`,
    });
  }

  const tasks = [];
  const seen = new Set();
  for (const hw of homeworkDetails) {
    for (const student of hw.students) {
      for (const cell of student.cells) {
        if (cell.rid && !seen.has(cell.rid)) {
          seen.add(cell.rid);
          tasks.push({ rid: cell.rid, homeworkId: hw.id, uid: student.uid });
        }
      }
    }
  }

  const cache = force ? {} : await readJson(CACHE_FILE, {});
  const records = new Map();
  for (const [rid, record] of Object.entries(cache)) records.set(rid, record);
  const missing = tasks.filter((task) => !records.get(task.rid)?.status);
  let fetched = 0;

  if (missing.length) {
    emit('records', `正在抓取做题记录 0/${missing.length}…`, 0, missing.length);
  }

  const jar = new CookieJar();
  await hydroLogin(jar);

  await mapLimit(missing, CONCURRENCY, async (task) => {
    const record = await fetchRecord(jar, task.rid);
    records.set(task.rid, record);
    fetched++;
    if (fetched % 10 === 0 || fetched === missing.length) {
      emit('records', `正在抓取做题记录 ${fetched}/${missing.length}…`, fetched, missing.length);
    }
  });

  const recordArray = [];
  for (const hw of homeworkDetails) {
    for (const student of hw.students) {
      for (const cell of student.cells) {
        if (!cell.rid) continue;
        const record = records.get(cell.rid);
        if (record) {
          // Keep the per-cell payload light; full code lives in the top-level record list.
          const { code, cases, ...summary } = record;
          cell.record = summary;
        }
        if (record && record.status && !record.error) recordArray.push(record);
      }
    }
  }

  // De-duplicate records in the top-level list.
  const uniqueRecords = [...new Map(recordArray.map((r) => [r.rid, r])).values()];

  const knownNext = { ...known };
  for (const hw of homeworkDetails) {
    knownNext[hw.id] = {
      title: hw.title,
      firstSeenAt: known[hw.id]?.firstSeenAt || now,
      lastSeenAt: now,
      problemCount: hw.problemCount,
    };
  }

  const allStudentMap = new Map();
  for (const hw of homeworkDetails) {
    for (const student of hw.students) {
      if (!allStudentMap.has(student.uid)) {
        allStudentMap.set(student.uid, { uid: student.uid, name: student.name });
      }
    }
  }

  const snapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      manager: `${MANAGER_ORIGIN}/homeWork`,
      student: `${STUDENT_BASE}/school/homework`,
      keyword: KEYWORD,
      studentUser: process.env.MARS_USER || '未配置',
    },
    homeworks: homeworkDetails,
    records: uniqueRecords,
    students: [...allStudentMap.values()].sort((a, b) => a.uid - b.uid),
    stats: {
      homeworkCount: homeworkDetails.length,
      studentCount: allStudentMap.size,
      problemCount: homeworkDetails.reduce((sum, hw) => sum + (hw.problemCount || 0), 0),
      recordCount: uniqueRecords.length,
      newHomeworkCount: homeworkDetails.filter((hw) => hw.isNew).length,
    },
  };

  await writeJson(SNAPSHOT_FILE, snapshot);
  await writeJson(KNOWN_FILE, knownNext);
  await writeJson(CACHE_FILE, Object.fromEntries([...records.entries()].filter(([, r]) => r && !r.error)));

  emit('done', '抓取完成', tasks.length, tasks.length, { stats: snapshot.stats });
  return snapshot;
}

export async function loadSnapshot() {
  return readJson(SNAPSHOT_FILE, null);
}

export async function loadKnown() {
  return readJson(KNOWN_FILE, {});
}

export const paths = { DATA_DIR, SNAPSHOT_FILE, KNOWN_FILE, CACHE_FILE };
