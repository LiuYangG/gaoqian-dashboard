import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ManagerClient, readJson, writeJson } from './lib/manager.mjs';

const KEYWORD = '高潜';
const TITLE_RE = /高潜\s*0*(\d+)/;
const DATA_DIR = path.resolve('data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const KNOWN_FILE = path.join(DATA_DIR, 'known-homeworks.json');
const CACHE_FILE = path.join(DATA_DIR, 'record-cache.json');
const CONCURRENCY = Number(process.env.MARS_CONCURRENCY || 6);

const STATUS_MAP = {
  0: { code: 'PD', label: '等待评测', tone: 'warn' },
  1: { code: 'AC', label: '通过', tone: 'ac' },
  2: { code: 'WA', label: '答案错误', tone: 'fail' },
  3: { code: 'TLE', label: '超时', tone: 'fail' },
  4: { code: 'MLE', label: '超内存', tone: 'fail' },
  5: { code: 'OLE', label: '输出超限', tone: 'fail' },
  6: { code: 'RE', label: '运行错误', tone: 'fail' },
  7: { code: 'CE', label: '编译错误', tone: 'fail' },
  8: { code: 'SE', label: '系统错误', tone: 'fail' },
  9: { code: 'CANCELED', label: '已取消', tone: 'warn' },
  10: { code: 'ETC', label: '其他', tone: 'warn' },
};
const CODE_MAP = {
  AC: STATUS_MAP[1], WA: STATUS_MAP[2], TLE: STATUS_MAP[3], MLE: STATUS_MAP[4], OLE: STATUS_MAP[5],
  RE: STATUS_MAP[6], CE: STATUS_MAP[7], SE: STATUS_MAP[8], PD: STATUS_MAP[0], CANCELED: STATUS_MAP[9],
  '已通过': STATUS_MAP[1], '答案错误': STATUS_MAP[2], '编译错误': STATUS_MAP[7], '运行错误': STATUS_MAP[6],
  '超出时间限制': STATUS_MAP[3], '超时': STATUS_MAP[3], '内存超限': STATUS_MAP[4], '输出超限': STATUS_MAP[5],
};

function decodeHtml(input = '') {
  return String(input)
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
  return decodeHtml(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const cnIso = (text) => {
  const m = String(text || '').match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? new Date(`${m[1]}T${m[2]}+08:00`).toISOString() : null;
};
const normalizeStatus = (code) => {
  const key = String(code || '').trim().toUpperCase();
  return CODE_MAP[key] || CODE_MAP[stripTags(code)] || { code: key.slice(0, 8) || 'UNK', label: stripTags(code) || '未知', tone: 'warn' };
};

/** Parse `/homework/{tid}/scoreboard`: problem columns and student rows with record ids. */
export function parseScoreboardHtml(html) {
  const problems = [];
  for (const m of html.matchAll(/<th[^>]*class="col--problem"[^>]*>\s*<a href="\/p\/([^"?]+)[^"]*"[^>]*(?:data-tooltip="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/g)) {
    const docId = Number(m[1]);
    const rawTitle = m[2] ? decodeHtml(m[2]) : stripTags(m[3]);
    const title = rawTitle.replace(/^[A-Z]\.\s*/, '').trim();
    if (Number.isFinite(docId)) problems.push({ docId, pid: String(docId), title });
  }
  const rows = [];
  for (const m of html.matchAll(/<tr data-au-uid="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const uid = Number(m[1]);
    const body = m[2];
    const name = decodeHtml((body.match(/class="au-user"[^>]*title="([^"]*)"/) || [])[1] || '') || stripTags((body.match(/class="au-user"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const rank = Number(stripTags((body.match(/class="col--rank"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '')) || rows.length + 1;
    const totalScore = Number(stripTags((body.match(/class="col--total_score"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '')) || 0;
    const totalTime = stripTags((body.match(/class="col--time"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '');
    const cells = [];
    for (const c of body.matchAll(/<td class="col--problem">([\s\S]*?)<\/td>/g)) {
      const cell = c[1];
      const rid = (cell.match(/\/record\/([0-9a-f]{24})/) || [])[1] || '';
      const cls = (cell.match(/class="(au-[a-z-]+)"/) || [])[1] || '';
      const text = stripTags(cell).replace(/\s+/g, ' ').trim();
      const score = Number((text.match(/(\d+)/) || [])[1]) || 0;
      const time = (text.match(/(\d{1,3}:\d{2})/) || [])[1] || '';
      const accepted = cls === 'au-accepted' || /✓/.test(text);
      cells.push({
        rid,
        accepted,
        submitted: Boolean(rid),
        status: rid ? (accepted ? 'ac' : 'attempted') : 'none',
        score,
        value: text,
        time,
      });
    }
    rows.push({ uid, name, rank, totalScore, totalTime, cells });
  }
  return { problems, rows };
}

/** Parse a record detail page into the legacy snapshot record shape. */
export function parseRecordDetailHtml(html, rid) {
  const statusNum = Number((html.match(/data-status="(\d+)"/) || [])[1] || 0);
  const stateText = stripTags((html.match(/class="ru-state[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/) || [])[1] || '');
  const status = statusNum ? (STATUS_MAP[statusNum] || normalizeStatus(stateText)) : normalizeStatus(stateText);

  const score = Number((html.match(/得分\s*<\/small><strong>(\d+)<\/strong>/) || [])[1]
    || (html.match(/class="ru-group-score">得分\s*(\d+)/) || [])[1] || 0);
  const totalTime = stripTags((html.match(/总耗时<\/small><strong>([^<]+)<\/strong>/) || [])[1] || '');
  const peakTime = stripTags((html.match(/单点峰值耗时<\/small><strong>([^<]+)<\/strong>/) || [])[1] || '');
  const peakMemory = stripTags((html.match(/峰值内存<\/small><strong>([^<]+)<\/strong>/) || [])[1] || '');
  const language = stripTags((html.match(/class="ru-language"[^>]*>([^<]+)/) || [])[1] || '');
  const codeLength = stripTags((html.match(/data-record-code-length>([^<]+)/) || [])[1] || '');

  const submitMatch = html.match(/<dt>提交时间<\/dt><dd>([\s\S]*?)<\/dd>/);
  const submitText = submitMatch ? stripTags(submitMatch[1]).replace(/\s*Asia\/Shanghai\s*/g, '').trim() : '';
  const submitAt = cnIso(submitText);
  const judgeText = stripTags((html.match(/data-record-judge-at>([^<]+)/) || [])[1] || '');
  const judgeAt = cnIso(judgeText) || submitAt;

  const userMatch = html.match(/class="user-profile-name[^"]*"\s+href="\/user\/(\d+)">\s*([\s\S]*?)<\/a>/);
  const user = userMatch ? { uid: Number(userMatch[1]), name: stripTags(userMatch[2]) } : null;
  const problemMatch = html.match(/<dt>题目<\/dt><dd><a href="\/p\/([^"?]+)[^"]*"><b>([^<]+)<\/b>\s*(?:&nbsp;)*\s*([\s\S]*?)<\/a>/);
  const problem = problemMatch ? { pid: stripTags(problemMatch[2]), name: decodeHtml(problemMatch[3] || '').trim() } : null;

  const codeMatch = html.match(/<code id="record-source"[^>]*>([\s\S]*?)<\/code>/);
  const code = codeMatch ? decodeHtml(codeMatch[1]).replace(/\r\n/g, '\n') : '';

  return {
    rid,
    status,
    score,
    totalTime,
    peakTime,
    peakMemory,
    language,
    codeLength,
    submitAt,
    submitText,
    judgeAt,
    judgeText,
    user,
    problem,
    homework: '',
    code,
    cases: [],
  };
}

/** Parse one page of `/record?tid=...` into lightweight attempt rows. */
export function parseRecordListHtml(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr data-rid="([0-9a-f]{24})">([\s\S]*?)<\/tr>/g)) {
    const rid = m[1];
    const body = m[2];
    const statusCode = stripTags((body.match(/<small>([^<]+)<\/small>/) || [])[1] || '');
    const score = Number(stripTags((body.match(/class="col--score[^"]*"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '')) || 0;
    const pid = (body.match(/\/p\/([^"?]+)/) || [])[1] || '';
    const title = stripTags((body.match(/class="ru-problem-name">([^<]+)/) || [])[1] || '');
    const userMatch = body.match(/class="user-profile-name[^"]*"\s+href="\/user\/(\d+)">\s*([\s\S]*?)<\/a>/);
    const uid = userMatch ? Number(userMatch[1]) : null;
    const uname = userMatch ? stripTags(userMatch[2]) : '';
    const at = body.match(/class="col--submit-at"[^>]*>\s*<span>(\d{4}-\d{2}-\d{2})<\/span><small[^>]*>(\d{2}:\d{2}:\d{2})/);
    const judgeAt = at ? new Date(`${at[1]}T${at[2]}+08:00`).toISOString() : null;
    const time = stripTags((body.match(/class="col--time"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '');
    const memory = stripTags((body.match(/class="col--memory"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '');
    const language = stripTags((body.match(/class="ru-language-label"[^>]*>([^<]+)/) || [])[1] || '');
    rows.push({ rid, uid, uname, pid, title, status: normalizeStatus(statusCode), score, judgeAt, time, memory, language });
  }
  return rows;
}

export function lastRecordPage(html) {
  const decoded = String(html).replace(/&amp;/g, '&');
  let max = 1;
  for (const m of decoded.matchAll(/[?&]page=(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export async function listHomeworkTitles() {
  const client = new ManagerClient({ concurrency: CONCURRENCY });
  const items = (await client.listHomeworks({ q: KEYWORD })).filter((h) => TITLE_RE.test(h.title));
  return items
    .map((h) => {
      const match = h.title.match(TITLE_RE);
      return {
        id: h.tid,
        title: h.title,
        classid: 'GX001',
        beginAt: h.beginAt,
        penaltySince: h.penaltySince ?? h.endAt ?? null,
        endAt: h.endAt ?? h.penaltySince ?? null,
        order: Number(match[1]),
        problemRefs: h.problemRefs || [],
      };
    })
    .sort((a, b) => a.order - b.order);
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
  const emit = (phase, message, current = 0, total = 0, extra = {}) => onProgress({ phase, message, current, total, startedAt, ...extra });
  emit('login', '正在登录 MarsOJ…');

  const client = new ManagerClient({ concurrency: CONCURRENCY });
  await client.login();

  emit('list', '正在检索“高潜”作业…');
  const homeworks = await listHomeworkTitles();
  if (!homeworks.length) throw new Error('未检索到“高潜”作业');

  const known = await readJson(KNOWN_FILE, {});
  const isFirstRun = Object.keys(known).length === 0;
  const now = new Date().toISOString();
  const cache = force ? {} : await readJson(CACHE_FILE, {});
  const details = [];
  const tasks = [];

  for (let i = 0; i < homeworks.length; i++) {
    const hw = homeworks[i];
    emit('homework', `读取作业：${hw.title}`, i, homeworks.length);
    const html = await client.getScoreboardHtml(hw.id);
    const parsed = parseScoreboardHtml(html);
    const refs = new Map((hw.problemRefs || []).map((r) => [Number(r.docId), r]));
    const problems = parsed.problems.map((p) => {
      const ref = refs.get(Number(p.docId));
      return { docId: p.docId, pid: ref?.pid || String(p.docId), title: ref?.title || p.title };
    });
    const rows = parsed.rows;
    const students = rows.map((row) => ({
      uid: row.uid,
      name: row.name,
      rank: row.rank,
      totalScore: row.totalScore,
      totalTime: row.totalTime,
      cells: row.cells.map((cell, index) => ({
        docId: problems[index]?.docId ?? null,
        pid: problems[index]?.pid ?? '',
        title: problems[index]?.title ?? '',
        status: cell.status,
        score: cell.score,
        isAc: cell.accepted,
        isSubmit: cell.submitted,
        rid: cell.rid,
        value: cell.value,
      })),
    }));
    for (const student of students) for (const cell of student.cells) if (cell.rid) tasks.push(cell.rid);
    details.push({
      id: hw.id,
      title: hw.title,
      classid: hw.classid,
      beginAt: hw.beginAt,
      endAt: hw.endAt,
      penaltySince: hw.penaltySince,
      order: hw.order,
      problemCount: problems.length,
      problems,
      students,
      noData: students.length === 0,
      firstSeenAt: known[hw.id]?.firstSeenAt || now,
      isNew: !isFirstRun && !known[hw.id],
      sourceUrl: `https://marsoj.cn/homework/${hw.id}/scoreboard`,
    });
  }

  const uniqueRids = [...new Set(tasks)];
  const missing = uniqueRids.filter((rid) => !cache[rid]?.code);
  let fetched = 0;
  if (missing.length) emit('records', `正在抓取做题记录 0/${missing.length}…`, 0, missing.length);
  await client.mapLimit(missing, async (rid) => {
    try {
      const html = await client.getRecordDetailHtml(rid);
      cache[rid] = parseRecordDetailHtml(html, rid);
    } catch (error) {
      cache[rid] = { rid, error: error.message };
    } finally {
      fetched++;
      if (fetched % 10 === 0 || fetched === missing.length) emit('records', `正在抓取做题记录 ${fetched}/${missing.length}…`, fetched, missing.length);
    }
  });

  for (const hw of details) {
    for (const student of hw.students) {
      for (const cell of student.cells) {
        if (!cell.rid) continue;
        const record = cache[cell.rid];
        if (record && !record.error) {
          const { code, cases, ...summary } = record;
          cell.record = { ...summary, homework: hw.title };
        }
      }
    }
  }

  const records = [];
  const seen = new Set();
  for (const hw of details) {
    for (const student of hw.students) {
      for (const cell of student.cells) {
        if (!cell.rid || seen.has(cell.rid)) continue;
        const record = cache[cell.rid];
        if (record && !record.error) { seen.add(cell.rid); records.push({ ...record, homework: hw.title }); }
      }
    }
  }

  const knownNext = { ...known };
  for (const hw of details) {
    knownNext[hw.id] = {
      title: hw.title,
      firstSeenAt: known[hw.id]?.firstSeenAt || now,
      lastSeenAt: now,
      problemCount: hw.problemCount,
    };
  }

  const studentMap = new Map();
  for (const hw of details) for (const s of hw.students) if (!studentMap.has(s.uid)) studentMap.set(s.uid, { uid: s.uid, name: s.name });

  const snapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      manager: 'https://marsoj.cn/manager/homeWork',
      student: 'https://marsoj.cn/homework',
      keyword: KEYWORD,
      studentUser: process.env.MARS_USER || '未配置',
    },
    homeworks: details,
    records,
    students: [...studentMap.values()].sort((a, b) => a.uid - b.uid),
    stats: {
      homeworkCount: details.length,
      studentCount: studentMap.size,
      problemCount: details.reduce((sum, hw) => sum + (hw.problemCount || 0), 0),
      recordCount: records.length,
      newHomeworkCount: details.filter((hw) => hw.isNew).length,
    },
  };

  await writeJson(SNAPSHOT_FILE, snapshot);
  await writeJson(KNOWN_FILE, knownNext);
  // Keep only records that are still part of the current scoreboard; old
  // duplicate/stale cache entries are dropped.
  const keptCache = {};
  for (const rid of uniqueRids) if (cache[rid]) keptCache[rid] = cache[rid];
  await writeJson(CACHE_FILE, keptCache);
  emit('done', '抓取完成', uniqueRids.length, uniqueRids.length, { stats: snapshot.stats });
  return snapshot;
}

export async function loadSnapshot() { return readJson(SNAPSHOT_FILE, null); }
export async function loadKnown() { return readJson(KNOWN_FILE, {}); }
export const paths = { DATA_DIR, SNAPSHOT_FILE, KNOWN_FILE, CACHE_FILE };
