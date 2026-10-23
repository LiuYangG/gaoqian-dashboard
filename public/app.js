(() => {
  'use strict';

  const state = {
    data: null,
    tab: 'overview',
    hwId: 'all',
    studentId: null,
    search: '',
    recHw: 'all',
    recStudent: 'all',
    recStatus: 'all',
    recSearch: '',
    recPage: 1,
    charts: {},
    scraping: false,
    progress: null,
    lastCheck: null,
    newHomeworks: [],
  };

  const PAGE_SIZE = 20;
  const STATIC = Boolean(window.DASHBOARD_STATIC);
  const NO_EVENTS = STATIC || new URLSearchParams(location.search).has('noevents');
  const staticUrl = (file) => new URL(file, document.baseURI).href;
  const COLORS = ['#4f46e5', '#0d9488', '#d97706', '#e11d48', '#2563eb', '#7c3aed'];
  const CELL_META = {
    ac: { label: '通过', short: '✓', cls: 'ac' },
    attempted: { label: '未通过', short: '×', cls: 'attempted' },
    pending: { label: '评测中', short: '…', cls: 'pending' },
    none: { label: '未提交', short: '·', cls: 'none' },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pct(value, digits = 1) {
    const n = Number(value) || 0;
    return `${(n * 100).toFixed(digits).replace(/\.0$/, '')}%`;
  }

  function pctNum(value, digits = 1) {
    return Number(((Number(value) || 0) * 100).toFixed(digits));
  }

  function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return new Date(s.replace(' ', 'T') + '+08:00');
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const dateFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });

  function fmtDate(value) {
    const d = toDate(value);
    return d ? dateFmt.format(d) : '—';
  }
  function fmtDateTime(value) {
    const d = toDate(value);
    return d ? dateTimeFmt.format(d) : '—';
  }
  function fmtTime(value) {
    const d = toDate(value);
    return d ? timeFmt.format(d) : '—';
  }
  function fmtDuration(value) {
    if (!value || value === '00:00:00') return '—';
    const parts = String(value).split(':').map(Number);
    if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
      const hours = parts[0] + parts[1] / 60;
      if (hours >= 100) return `${Math.round(hours)} h`;
      if (hours >= 1) return `${hours.toFixed(1)} h`;
      return `${parts[1]}m`;
    }
    return value;
  }
  function initial(name) {
    const s = String(name || '?').trim();
    return s ? s.slice(-1) : '?';
  }
  function avatar(name, extra = '') {
    return `<span class="avatar ${extra}">${esc(initial(name))}</span>`;
  }
  function hwShort(title) {
    return String(title || '').replace(/^山东/, '').replace(/^高潜\s*/, '高潜 ');
  }
  function hwColor(index) {
    return COLORS[index % COLORS.length];
  }

  const allHomeworks = () => [...(state.data?.homeworks || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const activeHomeworks = () => allHomeworks().filter((hw) => (hw.students || []).length > 0);
  const allStudents = () => state.data?.students || [];
  const studentName = (uid) => allStudents().find((s) => Number(s.uid) === Number(uid))?.name || String(uid);
  const findHw = (id) => allHomeworks().find((h) => h.id === id);
  const findStudentRow = (hw, uid) => (hw.students || []).find((s) => Number(s.uid) === Number(uid));

  function classSize(hw) {
    const peers = allHomeworks().filter((item) => item.classid === hw.classid && (item.students || []).length > 0);
    if (peers.length) return Math.max(...peers.map((item) => item.students.length));
    return allStudents().length;
  }

  function summarizeHw(hw) {
    const problems = hw.problemCount || (hw.problems || []).length || 0;
    const students = hw.students || [];
    const rosterCount = students.length || classSize(hw);
    let ac = 0;
    let attempted = 0;
    let none = 0;
    let records = 0;
    let score = 0;
    let lastSubmit = null;
    for (const student of students) {
      score += Number(student.totalScore) || 0;
      for (const cell of student.cells || []) {
        if (cell.status === 'ac') ac += 1;
        else if (cell.status === 'attempted') attempted += 1;
        else none += 1;
        if (cell.rid) records += 1;
        if (cell.record?.submitAt && (!lastSubmit || cell.record.submitAt > lastSubmit)) lastSubmit = cell.record.submitAt;
      }
    }
    const totalCells = students.length * problems;
    return {
      problems,
      studentCount: rosterCount,
      ac,
      attempted,
      none,
      records,
      score,
      totalCells,
      avgScore: students.length ? score / students.length : 0,
      maxScore: problems * 100,
      completion: totalCells ? ac / totalCells : 0,
      scorePct: totalCells ? score / (students.length * problems * 100) : 0,
      submittedStudents: students.filter((s) => (s.cells || []).some((c) => c.rid)).length,
      lastSubmit,
    };
  }

  function summarizeStudent(uid, hw) {
    const problems = hw.problemCount || (hw.problems || []).length || 0;
    const row = findStudentRow(hw, uid);
    const cells = row?.cells || [];
    const ac = cells.filter((c) => c.status === 'ac').length;
    const attempted = cells.filter((c) => c.status === 'attempted').length;
    const records = cells.filter((c) => c.rid).length;
    const score = Number(row?.totalScore) || 0;
    let lastSubmit = null;
    for (const cell of cells) {
      if (cell.record?.submitAt && (!lastSubmit || cell.record.submitAt > lastSubmit)) lastSubmit = cell.record.submitAt;
    }
    return {
      row,
      problems,
      ac,
      attempted,
      none: Math.max(0, problems - ac - attempted),
      records,
      score,
      maxScore: problems * 100,
      completion: problems ? ac / problems : 0,
      scorePct: problems ? score / (problems * 100) : 0,
      lastSubmit,
    };
  }

  function overallStudent(uid) {
    const hws = activeHomeworks();
    let problems = 0;
    let ac = 0;
    let attempted = 0;
    let records = 0;
    let score = 0;
    let maxScore = 0;
    let lastSubmit = null;
    const perHw = [];
    for (const hw of hws) {
      const s = summarizeStudent(uid, hw);
      problems += s.problems;
      ac += s.ac;
      attempted += s.attempted;
      records += s.records;
      score += s.score;
      maxScore += s.maxScore;
      if (s.lastSubmit && (!lastSubmit || s.lastSubmit > lastSubmit)) lastSubmit = s.lastSubmit;
      perHw.push({ hw, ...s });
    }
    return {
      uid,
      name: studentName(uid),
      problems,
      ac,
      attempted,
      records,
      score,
      maxScore,
      completion: problems ? ac / problems : 0,
      scorePct: maxScore ? score / maxScore : 0,
      lastSubmit,
      perHw,
    };
  }

  function globalStats() {
    const hws = allHomeworks();
    const active = activeHomeworks();
    const students = allStudents();
    let problems = 0;
    let ac = 0;
    let attempted = 0;
    let none = 0;
    let score = 0;
    for (const hw of active) {
      const s = summarizeHw(hw);
      problems += s.problems;
      ac += s.ac;
      attempted += s.attempted;
      none += s.none;
      score += s.score;
    }
    const totalCells = ac + attempted + none;
    return {
      homeworkCount: hws.length,
      activeCount: active.length,
      studentCount: students.length,
      problemCount: hws.reduce((sum, hw) => sum + (hw.problemCount || 0), 0),
      activeProblemCount: problems,
      recordCount: (state.data?.records || []).length,
      ac,
      attempted,
      none,
      totalCells,
      completion: totalCells ? ac / totalCells : 0,
      scorePct: problems && students.length ? score / (students.length * problems * 100) : 0,
      newCount: hws.filter((h) => h.isNew).length,
    };
  }

  function problemStats(hw) {
    const problems = hw.problems || [];
    const students = hw.students || [];
    return problems.map((problem, index) => {
      let ac = 0;
      let attempted = 0;
      let score = 0;
      let submitted = 0;
      for (const student of students) {
        const cell = (student.cells || []).find((c) => Number(c.docId) === Number(problem.docId));
        if (!cell) continue;
        if (cell.status === 'ac') ac += 1;
        if (cell.status === 'attempted') attempted += 1;
        if (cell.rid) submitted += 1;
        score += Number(cell.score) || 0;
      }
      return {
        ...problem,
        index: index + 1,
        ac,
        attempted,
        submitted,
        avgScore: students.length ? score / students.length : 0,
        acRate: students.length ? ac / students.length : 0,
      };
    });
  }

  function allRecords() {
    return state.data?.records || [];
  }

  function recordTone(code) {
    if (code === 'AC') return 'ac';
    if (['CE', 'WA', 'TLE', 'MLE', 'RE', 'SE', 'OLE', 'JF', 'IE'].includes(code)) return 'fail';
    return 'warn';
  }

  function recordStatusChip(record) {
    const code = record?.status?.code || 'UNK';
    const tone = recordTone(code);
    return `<span class="status-chip ${tone}">${esc(code)}</span>`;
  }

  function cellTitle(hw, student, cell) {
    const meta = CELL_META[cell.status] || CELL_META.none;
    const detail = cell.rid && cell.record ? ` · ${cell.record.status?.code || ''} ${cell.record.score ?? ''}分` : '';
    return `${hw.title} · ${student.name} · ${cell.pid || '题目'} ${cell.title || ''} · ${meta.label}${detail}`;
  }

  // ---------- Static shell helpers ----------
  function updateTabs() {
    $$('#tabs .tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === state.tab));
    $('#tabHwCount').textContent = allHomeworks().length;
    $('#tabStudentCount').textContent = allStudents().length;
    $('#tabRecordCount').textContent = allRecords().length;
  }

  function renderPills() {
    const hws = allHomeworks();
    const chips = [`<button class="pill ${state.hwId === 'all' ? 'active' : ''}" data-hw="all">全部作业 <span class="badge indigo">${hws.length}</span></button>`];
    for (const hw of hws) {
      const isNew = hw.isNew ? '<span class="new-dot" title="新增作业"></span>' : '';
      const noData = hw.noData ? '<span class="badge">待开始</span>' : '';
      chips.push(`<button class="pill ${state.hwId === hw.id ? 'active' : ''}" data-hw="${esc(hw.id)}" title="${esc(hw.title)}">${esc(hwShort(hw.title))}${isNew}${noData}</button>`);
    }
    $('#homeworkPills').innerHTML = chips.join('');
  }

  function setSync(running = false) {
    const dot = $('#statusDot');
    const text = $('#syncText');
    const generated = state.data?.generatedAt;
    if (STATIC) {
      dot.classList.remove('busy');
      text.textContent = state.data ? '静态数据已发布' : '加载数据中…';
      $('#syncSub').textContent = generated ? `GitHub Pages · ${fmtDateTime(generated)} 发布` : 'GitHub Pages · Actions 自动更新';
      $('#autoCheckLabel').firstChild.textContent = '由 GitHub Actions 每天 00:00 更新 · ';
      $('#lastCheck').textContent = generated ? fmtDateTime(generated) : '—';
      $('#footerMeta').textContent = generated
        ? `${allHomeworks().length} 次作业 · ${allStudents().length} 名学员 · ${allRecords().length} 条记录 · 发布于 ${fmtDateTime(generated)}`
        : '尚未发布数据';
      return;
    }
    if (running) {
      dot.classList.add('busy');
      text.textContent = '正在抓取…';
    } else {
      dot.classList.remove('busy');
      text.textContent = state.data ? '数据已就绪' : '等待抓取';
    }
    $('#syncSub').textContent = generated ? `更新于 ${fmtDateTime(generated)}` : '数据来自 manager.marsoj.cn';
    $('#footerMeta').textContent = generated
      ? `${allHomeworks().length} 次作业 · ${allStudents().length} 名学员 · ${allRecords().length} 条记录 · 更新于 ${fmtDateTime(generated)}`
      : '尚未抓取';
  }

  function setRefreshBusy(busy) {
    state.scraping = busy;
    const btn = $('#refreshBtn');
    btn.disabled = busy;
    $('#refreshIcon').innerHTML = busy ? '<span class="spinner" style="margin:0"></span>' : '↻';
    setSync(busy);
  }

  // ---------- Overview ----------
  function kpiCard(icon, label, value, foot, color, tint) {
    return `<div class="card kpi" style="--kpi-color:${color};--kpi-tint:${tint}">
      <div class="kpi-icon">${icon}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-foot">${foot}</div>
    </div>`;
  }

  function heatmapHtml() {
    const hws = allHomeworks();
    const students = allStudents();
    const header = ['<div></div>'].concat(hws.map((hw) => `<div class="heat-head" title="${esc(hw.title)}">${esc(hwShort(hw.title))}${hw.noData ? '<br><span class="tiny">待开始</span>' : ''}</div>`)).join('');
    const rows = students.map((student) => {
      const cells = hws.map((hw) => {
        const s = summarizeStudent(student.uid, hw);
        if (!hw.students || !hw.students.length) {
          return `<div class="heat-cell is-empty" title="${esc(student.name)} · ${esc(hw.title)} · 尚未产生提交">—</div>`;
        }
        const p = s.completion * 100;
        const alpha = (0.07 + (p / 100) * 0.86).toFixed(2);
        const color = p >= 52 ? '#ffffff' : '#312e81';
        return `<div class="heat-cell" data-student="${student.uid}" style="background:rgba(79,70,229,${alpha});color:${color}" title="${esc(student.name)} · ${esc(hw.title)} · 完成 ${pct(s.completion)}（${s.ac}/${s.problems}）">${p.toFixed(0)}%</div>`;
      }).join('');
      return `<div class="heat-row-label">${avatar(student.name)}${esc(student.name)}</div>${cells}`;
    }).join('');
    return `<div class="heat-scroll"><div class="heat-grid" style="grid-template-columns:120px repeat(${hws.length}, minmax(0,1fr))">${header}${rows}</div></div>`;
  }

  function leaderRows() {
    return allStudents()
      .map((s) => overallStudent(s.uid))
      .sort((a, b) => b.completion - a.completion || b.score - a.score || a.uid - b.uid);
  }

  function overviewHtml() {
    const hws = allHomeworks();
    const active = activeHomeworks();
    const g = globalStats();
    const leaders = leaderRows();
    const top = leaders.slice(0, 5);

    return `
      <div class="grid kpi-grid">
        ${kpiCard('▤', '高潜作业', `${g.homeworkCount}<small>次</small>`, `${g.activeCount} 次已产生提交`, '#4f46e5', '#eef0ff')}
        ${kpiCard('◉', '学员', `${g.studentCount}<small>人</small>`, '来自成绩表名单', '#0d9488', '#ccfbf1')}
        ${kpiCard('▦', '题目总量', `${g.problemCount}<small>题</small>`, `已提交 ${g.recordCount} 条记录`, '#2563eb', '#dbeafe')}
        ${kpiCard('✓', '通过题次', `${g.ac}<small>次</small>`, `另有 ${g.attempted} 次未通过`, '#059669', '#d1fae5')}
        ${kpiCard('◔', '平均完成率', `${pct(g.completion)}`, `基于 ${g.activeCount} 次已提交作业`, '#d97706', '#fef3c7')}
      </div>

      <div class="grid two-col" style="margin-top:18px">
        <div class="card">
          <div class="card-head">
            <div><h3 class="card-title">每次作业完成趋势</h3><p class="card-sub">柱状为平均完成率，折线为已提交学员数</p></div>
            <span class="badge indigo">${hws.length} 次作业</span>
          </div>
          <div id="chartTrend" class="chart"></div>
        </div>
        <div class="card">
          <div class="card-head">
            <div><h3 class="card-title">题目状态分布</h3><p class="card-sub">仅统计已产生提交的作业</p></div>
            <span class="badge green">通过 ${pct(g.totalCells ? g.ac / g.totalCells : 0)}</span>
          </div>
          <div id="chartStatus" class="chart"></div>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head">
          <div><h3 class="card-title">学员 × 作业 完成热力图</h3><p class="card-sub">颜色越深表示完成率越高；灰色表示该次作业尚未产生提交</p></div>
          <div class="heat-scale"><span>0%</span><span class="bar"></span><span>100%</span></div>
        </div>
        ${heatmapHtml()}
      </div>

      <div class="grid two-col" style="margin-top:18px">
        <div class="card">
          <div class="card-head">
            <div><h3 class="card-title">学员完成率排行</h3><p class="card-sub">按已提交作业的逐题完成率排序</p></div>
            <span class="badge">${leaders.length} 人</span>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width:44px">#</th><th>学员</th><th>完成率</th><th class="right">通过</th><th class="right">总分</th></tr></thead>
              <tbody>
                ${top.map((s, i) => `<tr class="clickable" data-student="${s.uid}">
                  <td><span class="badge ${i === 0 ? 'amber' : i === 1 ? 'blue' : i === 2 ? 'indigo' : ''}">${i + 1}</span></td>
                  <td><div class="user-cell">${avatar(s.name)}<span class="name">${esc(s.name)}</span></div></td>
                  <td style="min-width:140px"><div style="display:flex;align-items:center;gap:9px"><div class="progress" style="flex:1"><span style="width:${pctNum(s.completion)}%"></span></div><b class="num tiny">${pct(s.completion)}</b></div></td>
                  <td class="right num">${s.ac}<span class="muted">/${s.problems}</span></td>
                  <td class="right num"><b>${s.score}</b></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div><h3 class="card-title">作业进度</h3><p class="card-sub">点击进入逐题完成矩阵</p></div>
          </div>
          <div style="display:grid;gap:13px">
            ${hws.map((hw, i) => {
              const s = summarizeHw(hw);
              return `<div style="cursor:pointer" data-hw="${esc(hw.id)}">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
                  <div style="display:flex;align-items:center;gap:7px;font-weight:700;font-size:12.5px">${esc(hwShort(hw.title))}${hw.isNew ? '<span class="badge new">新增</span>' : ''}${hw.noData ? '<span class="badge">待开始</span>' : ''}</div>
                  <div class="tiny muted">${hw.noData ? '暂无提交' : `${s.submittedStudents}/${s.studentCount} 人 · ${pct(s.completion)}`}</div>
                </div>
                <div class="progress ${hw.noData ? '' : 'green'}" style="height:8px"><span style="width:${hw.noData ? 0 : pctNum(s.completion)}%;background:${hwColor(i)}"></span></div>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head">
          <div><h3 class="card-title">全部作业</h3><p class="card-sub">系统会自动检索新出现的“高潜”作业</p></div>
          <span class="badge ${g.newCount ? 'new' : 'indigo'}">${g.newCount ? `${g.newCount} 个新增` : '已同步'}</span>
        </div>
        <div class="grid hw-grid">
          ${hws.map((hw, i) => hwCard(hw, i)).join('')}
        </div>
      </div>
    `;
  }

  function hwCard(hw, index) {
    const s = summarizeHw(hw);
    const color = hwColor(index);
    return `<div class="hw-card" data-hw="${esc(hw.id)}" style="--accent:${color}">
      <div class="hw-top">
        <div>
          <div class="hw-name">${esc(hw.title)} ${hw.isNew ? '<span class="badge new">新增</span>' : ''}</div>
          <div class="hw-meta">班级 ${esc(hw.classid || '—')} · ${fmtDate(hw.beginAt)}</div>
        </div>
        <div class="hw-score">${hw.noData ? '—' : Math.round(s.avgScore)}<small> 平均分</small></div>
      </div>
      <div class="hw-stats">
        <div class="hw-stat"><b>${s.problems}</b><span>题目</span></div>
        <div class="hw-stat"><b>${s.studentCount || '—'}</b><span>学员</span></div>
        <div class="hw-stat"><b>${s.records}</b><span>记录</span></div>
      </div>
      <div class="hw-progress">
        <div class="hw-progress-label"><span>平均完成率</span><b>${hw.noData ? '待开始' : pct(s.completion)}</b></div>
        <div class="progress" style="height:8px"><span style="width:${hw.noData ? 0 : pctNum(s.completion)}%;background:${color}"></span></div>
      </div>
    </div>`;
  }

  // ---------- Homework ----------
  function homeworkListHtml() {
    const hws = allHomeworks();
    return `
      <div class="card">
        <div class="card-head">
          <div><h3 class="card-title">作业总览</h3><p class="card-sub">共 ${hws.length} 次“高潜”作业，点击任一行查看逐题矩阵与学员完成情况</p></div>
          <span class="badge indigo">自动发现新作业</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>作业</th><th>班级</th><th class="right">题目</th><th class="right">学员</th><th>平均完成率</th><th class="right">平均分</th><th class="right">提交记录</th><th>开始时间</th></tr></thead>
            <tbody>
              ${hws.map((hw, i) => {
                const s = summarizeHw(hw);
                return `<tr class="clickable" data-hw="${esc(hw.id)}">
                  <td><div style="display:flex;align-items:center;gap:8px"><span style="width:4px;height:26px;border-radius:4px;background:${hwColor(i)};display:inline-block"></span><b>${esc(hw.title)}</b>${hw.isNew ? '<span class="badge new">新增</span>' : ''}${hw.noData ? '<span class="badge">待开始</span>' : ''}</div></td>
                  <td class="muted">${esc(hw.classid || '—')}</td>
                  <td class="right num">${s.problems}</td>
                  <td class="right num">${s.studentCount || '—'}</td>
                  <td style="min-width:150px">${hw.noData ? '<span class="muted tiny">暂无提交</span>' : `<div style="display:flex;align-items:center;gap:8px"><div class="progress" style="flex:1"><span style="width:${pctNum(s.completion)}%;background:${hwColor(i)}"></span></div><b class="tiny num">${pct(s.completion)}</b></div>`}</td>
                  <td class="right num">${hw.noData ? '—' : Math.round(s.avgScore)}</td>
                  <td class="right num">${s.records}</td>
                  <td class="muted tiny">${fmtDate(hw.beginAt)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="grid hw-grid" style="margin-top:18px">${hws.map((hw, i) => hwCard(hw, i)).join('')}</div>
    `;
  }

  function homeworkDetailHtml(hw) {
    const s = summarizeHw(hw);
    const stats = problemStats(hw);
    const students = [...(hw.students || [])].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
    const rankMap = new Map(students.map((row, i) => [row.uid, i + 1]));
    const problemHeaders = (hw.problems || []).map((p, i) => `<th class="prob-head" title="${esc(p.pid)} ${esc(p.title)}">${i + 1}</th>`).join('');

    return `
      <div class="card" style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;background:linear-gradient(120deg,#fff,#f8faff)">
        <button class="btn btn-soft btn-sm" data-action="back-homework">← 全部作业</button>
        <div style="flex:1;min-width:220px">
          <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
            <h2 style="margin:0;font-size:21px">${esc(hw.title)}</h2>
            ${hw.isNew ? '<span class="badge new">新增作业</span>' : ''}
            ${hw.noData ? '<span class="badge">待开始</span>' : ''}
          </div>
          <div class="muted tiny" style="margin-top:4px">班级 ${esc(hw.classid || '—')} · ${fmtDate(hw.beginAt)} 开始 · 截止 ${fmtDate(hw.endAt)}</div>
        </div>
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div><div class="tiny muted">参考学员</div><b style="font-size:20px">${s.studentCount || '—'}</b></div>
          <div><div class="tiny muted">题目</div><b style="font-size:20px">${s.problems}</b></div>
          <div><div class="tiny muted">提交记录</div><b style="font-size:20px">${s.records}</b></div>
          <div><div class="tiny muted">平均完成率</div><b style="font-size:20px;color:var(--brand)">${hw.noData ? '—' : pct(s.completion)}</b></div>
        </div>
      </div>

      <div class="grid kpi-grid" style="margin-top:18px">
        ${kpiCard('▦', '题目数', `${s.problems}<small>题</small>`, '本次作业题目总量', '#4f46e5', '#eef0ff')}
        ${kpiCard('◉', '提交学员', `${s.submittedStudents}<small>/${s.studentCount || 0} 人</small>`, `共 ${s.studentCount} 名学员`, '#0d9488', '#ccfbf1')}
        ${kpiCard('✓', '通过题次', `${s.ac}<small>次</small>`, `未通过 ${s.attempted} 次`, '#059669', '#d1fae5')}
        ${kpiCard('◔', '平均得分率', hw.noData ? '—' : `${pct(s.scorePct)}`, hw.noData ? '暂无提交数据' : `平均分 ${Math.round(s.avgScore)} / ${s.maxScore}`, '#2563eb', '#dbeafe')}
        ${kpiCard('◷', '最后提交', s.lastSubmit ? fmtTime(s.lastSubmit) : '—', s.lastSubmit ? fmtDate(s.lastSubmit) : '暂无提交', '#d97706', '#fef3c7')}
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head">
          <div><h3 class="card-title">学员完成情况</h3><p class="card-sub">按总分排序，点击学员查看个人画像</p></div>
          <span class="badge ${hw.noData ? '' : 'green'}">${hw.noData ? '暂无提交' : `${s.submittedStudents} 人已提交`}</span>
        </div>
        ${students.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th style="width:52px">排名</th><th>学员</th><th class="right">总分</th><th>完成率</th><th class="right">通过</th><th class="right">未通过</th><th class="right">未提交</th><th class="right">提交</th><th>最后提交</th><th style="width:70px"></th></tr></thead>
          <tbody>
            ${students.map((row) => {
              const st = summarizeStudent(row.uid, hw);
              const rank = rankMap.get(row.uid);
              return `<tr class="clickable" data-student="${row.uid}">
                <td><span class="badge ${rank === 1 ? 'amber' : rank === 2 ? 'blue' : rank === 3 ? 'indigo' : ''}">${rank}</span></td>
                <td><div class="user-cell">${avatar(row.name)}<span class="name">${esc(row.name)}</span><span class="muted tiny">#${row.uid}</span></div></td>
                <td class="right num"><b>${row.totalScore || 0}</b><span class="muted">/${st.maxScore}</span></td>
                <td style="min-width:140px"><div style="display:flex;align-items:center;gap:8px"><div class="progress green" style="flex:1"><span style="width:${pctNum(st.completion)}%"></span></div><b class="tiny num">${pct(st.completion)}</b></div></td>
                <td class="right num">${st.ac}</td>
                <td class="right num">${st.attempted}</td>
                <td class="right num">${st.none}</td>
                <td class="right num">${st.records}</td>
                <td class="muted tiny">${st.lastSubmit ? fmtDateTime(st.lastSubmit) : '—'}</td>
                <td><button class="btn btn-soft btn-sm" data-student="${row.uid}">查看</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>` : `<div class="empty compact"><div class="empty-icon">◔</div><h3>本次作业暂无提交记录</h3><p>作业已布置，但还没有学员提交。稍后重新抓取即可看到最新情况。</p></div>`}
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head">
          <div><h3 class="card-title">逐题完成矩阵</h3><p class="card-sub">行是学员，列是题目；点击任意彩色格子查看该次提交的代码与评测详情</p></div>
          <div class="legend">
            <span><i style="background:#d1fae5"></i>通过</span>
            <span><i style="background:#fef3c7"></i>未通过</span>
            <span><i style="background:#f8fafc;border:1px solid #e2e8f0"></i>未提交</span>
          </div>
        </div>
        ${students.length ? `<div class="matrix-wrap"><table class="matrix">
          <thead><tr><th class="sticky-col">学员 / 题目</th>${problemHeaders}</tr></thead>
          <tbody>
            ${students.map((row) => `<tr>
              <td class="sticky-col"><div class="user-cell">${avatar(row.name)}<span class="name" style="font-size:11.5px">${esc(row.name)}</span></div></td>
              ${(row.cells || []).map((cell) => {
                const meta = CELL_META[cell.status] || CELL_META.none;
                const disabled = !cell.rid;
                return `<td><button class="cell-btn ${meta.cls}" ${disabled ? 'disabled' : `data-record="${esc(cell.rid)}"`} title="${esc(cellTitle(hw, row, cell))}">${meta.short}</button></td>`;
              }).join('')}
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="muted" style="padding:10px 0">暂无学员数据</div>'}
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head">
          <div><h3 class="card-title">逐题统计</h3><p class="card-sub">AC 率 = 通过人数 / 学员人数</p></div>
          <span class="badge">${stats.length} 题</span>
        </div>
        <div class="table-wrap tall">
          <table class="data">
            <thead><tr><th style="width:44px">#</th><th>题目</th><th class="right">通过</th><th class="right">未通过</th><th>AC 率</th><th class="right">平均分</th><th>难度</th></tr></thead>
            <tbody>
              ${stats.map((p) => {
                const noStudents = !(hw.students || []).length;
                const tone = noStudents ? '' : p.acRate >= 0.8 ? 'green' : p.acRate >= 0.5 ? 'amber' : 'rose';
                const label = noStudents ? '待开始' : p.acRate >= 0.8 ? '简单' : p.acRate >= 0.5 ? '中等' : '较难';
                return `<tr>
                  <td class="muted num">${p.index}</td>
                  <td><b class="mono" style="font-size:11.5px">${esc(p.pid)}</b> <span class="muted">${esc(p.title)}</span></td>
                  <td class="right num">${p.ac}</td>
                  <td class="right num">${p.attempted}</td>
                  <td style="min-width:150px"><div style="display:flex;align-items:center;gap:8px"><div class="progress ${tone}" style="flex:1"><span style="width:${pctNum(p.acRate)}%"></span></div><b class="tiny num">${pct(p.acRate)}</b></div></td>
                  <td class="right num">${p.avgScore.toFixed(0)}</td>
                  <td><span class="badge ${tone}">${label}</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderHomework() {
    const hw = state.hwId === 'all' ? null : findHw(state.hwId);
    return hw ? homeworkDetailHtml(hw) : homeworkListHtml();
  }

  // ---------- Students ----------
  function filterStudents(students) {
    const q = state.search.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) => String(s.name).toLowerCase().includes(q) || String(s.uid).includes(q));
  }

  function studentsHtml() {
    const list = filterStudents(allStudents()).map((s) => overallStudent(s.uid)).sort((a, b) => b.completion - a.completion || b.score - a.score);
    return `
      <div class="card">
        <div class="card-head">
          <div><h3 class="card-title">学员概览</h3><p class="card-sub">共 ${allStudents().length} 名学员，按已提交作业的整体完成率排序</p></div>
          <span class="badge indigo">点击查看个人画像</span>
        </div>
        ${list.length ? `<div class="grid student-grid">
          ${list.map((s) => {
            const ringColor = s.completion >= 0.8 ? '#059669' : s.completion >= 0.5 ? '#d97706' : '#e11d48';
            return `<div class="student-card" data-student="${s.uid}">
              <div style="display:flex;align-items:center;gap:12px">
                <div class="ring" style="--p:${pctNum(s.completion)};--ring-color:${ringColor}"><b>${pct(s.completion, 0)}</b></div>
                <div style="min-width:0">
                  <div class="student-card-head"><div><div class="name">${esc(s.name)}</div><div class="sub">UID ${s.uid}</div></div></div>
                  <div class="tiny muted" style="margin-top:4px">通过 ${s.ac}/${s.problems} 题 · 总分 ${s.score}</div>
                </div>
              </div>
              <div class="mini-bars">
                ${s.perHw.map((item, i) => `<div class="mini-bar"><span>${esc(hwShort(item.hw.title))}</span><div class="progress ${item.completion >= 0.8 ? 'green' : item.completion >= 0.5 ? 'amber' : 'rose'}" style="height:5px"><span style="width:${pctNum(item.completion)}%;background:${hwColor(i)}"></span></div><span class="num">${pct(item.completion, 0)}</span></div>`).join('')}
              </div>
              <div class="kpis">
                <div><b>${s.ac}</b><span>通过题数</span></div>
                <div><b>${s.records}</b><span>提交记录</span></div>
                <div><b>${s.lastSubmit ? fmtDate(s.lastSubmit) : '—'}</b><span>最后提交</span></div>
              </div>
            </div>`;
          }).join('')}
        </div>` : '<div class="empty compact"><div class="empty-icon">⌕</div><h3>没有匹配的学员</h3><p>换个关键词试试。</p></div>'}
      </div>
    `;
  }

  function studentDetailHtml(uid) {
    const student = allStudents().find((s) => Number(s.uid) === Number(uid));
    const o = overallStudent(uid);
    const hws = activeHomeworks();
    const recent = allRecords()
      .filter((r) => Number(r.user?.uid) === Number(uid))
      .sort((a, b) => String(b.submitAt).localeCompare(String(a.submitAt)))
      .slice(0, 8);

    return `
      <button class="btn btn-soft btn-sm" data-action="back-students">← 返回学员列表</button>
      <div class="profile" style="margin-top:12px">
        ${avatar(student?.name)}
        <div>
          <h2>${esc(student?.name || uid)}</h2>
          <p>UID ${uid} · 高潜班学员 · 数据来自 MarsOJ 成绩表</p>
        </div>
        <div class="profile-stats">
          <div><b style="color:#a5b4fc">${pct(o.completion)}</b><span>整体完成率</span></div>
          <div><b>${o.ac}/${o.problems}</b><span>通过 / 总题</span></div>
          <div><b>${o.score}</b><span>总得分</span></div>
          <div><b>${o.records}</b><span>提交记录</span></div>
        </div>
      </div>

      <div class="grid kpi-grid">
        ${kpiCard('✓', '通过题数', `${o.ac}<small>题</small>`, `共 ${o.problems} 题`, '#059669', '#d1fae5')}
        ${kpiCard('×', '未通过', `${o.attempted}<small>次</small>`, '提交但未 AC', '#d97706', '#fef3c7')}
        ${kpiCard('◷', '提交记录', `${o.records}<small>条</small>`, '逐题最佳提交', '#2563eb', '#dbeafe')}
        ${kpiCard('◔', '得分率', `${pct(o.scorePct)}`, `${o.score} / ${o.maxScore}`, '#4f46e5', '#eef0ff')}
        ${kpiCard('◉', '作业覆盖', `${hws.length}<small>次</small>`, '已产生提交的作业', '#0d9488', '#ccfbf1')}
      </div>

      <div class="grid two-col" style="margin-top:18px">
        <div class="card">
          <div class="card-head"><div><h3 class="card-title">各次作业完成率</h3><p class="card-sub">雷达图越大，整体完成度越高</p></div></div>
          <div id="chartRadar" class="chart"></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3 class="card-title">作业明细</h3><p class="card-sub">点击进入该次作业的逐题矩阵</p></div></div>
          <div style="display:grid;gap:11px">
            ${hws.map((hw, i) => {
              const s = summarizeStudent(uid, hw);
              return `<div data-hw="${esc(hw.id)}" style="cursor:pointer;border:1px solid var(--line);border-radius:12px;padding:11px 13px">
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                  <b style="font-size:12.5px">${esc(hwShort(hw.title))}</b>
                  <span class="tiny muted">${s.ac}/${s.problems} 题 · ${s.score} 分</span>
                </div>
                <div class="progress" style="height:6px;margin-top:8px"><span style="width:${pctNum(s.completion)}%;background:${hwColor(i)}"></span></div>
                <div style="display:flex;gap:10px;margin-top:6px" class="tiny muted"><span>完成 ${pct(s.completion)}</span><span>通过 ${s.ac}</span><span>未通过 ${s.attempted}</span></div>
              </div>`;
            }).join('')}
            ${allHomeworks().filter((hw) => !hw.students.length).map((hw) => `<div style="border:1px dashed var(--line-strong);border-radius:12px;padding:11px 13px;color:var(--muted)"><div style="display:flex;justify-content:space-between"><b style="font-size:12.5px">${esc(hwShort(hw.title))}</b><span class="badge">待开始</span></div><div class="tiny" style="margin-top:4px">该次作业尚未产生提交</div></div>`).join('')}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head">
          <div><h3 class="card-title">逐题状态</h3><p class="card-sub">按作业分组，点击彩色方块查看提交详情</p></div>
          <div class="legend"><span><i style="background:#d1fae5"></i>通过</span><span><i style="background:#fef3c7"></i>未通过</span><span><i style="background:#f8fafc;border:1px solid #e2e8f0"></i>未提交</span></div>
        </div>
        ${activeHomeworks().map((hw) => {
          const row = findStudentRow(hw, uid);
          const cells = row?.cells || [];
          return `<div style="margin-bottom:15px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px"><b style="font-size:12.5px">${esc(hwShort(hw.title))}</b><span class="tiny muted">${esc(hw.title)}</span></div>
            <div class="problem-strip">
              ${cells.map((cell, index) => {
                const meta = CELL_META[cell.status] || CELL_META.none;
                return `<button class="problem-dot ${meta.cls}" ${cell.rid ? `data-record="${esc(cell.rid)}"` : 'disabled'} title="${esc(cellTitle(hw, { name: student?.name || uid }, cell))}">${index + 1}</button>`;
              }).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head">
          <div><h3 class="card-title">最近提交</h3><p class="card-sub">最近 8 条做题记录</p></div>
          <button class="btn btn-soft btn-sm" data-action="records-student">查看全部 →</button>
        </div>
        ${recent.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>提交时间</th><th>作业</th><th>题目</th><th>状态</th><th class="right">分数</th><th class="right">耗时</th><th>语言</th></tr></thead>
          <tbody>${recent.map((r) => `<tr class="clickable" data-record="${esc(r.rid)}">
            <td class="muted tiny">${fmtDateTime(r.submitAt)}</td>
            <td class="tiny">${esc(r.homework)}</td>
            <td><b class="mono" style="font-size:11px">${esc(r.problem?.pid || '')}</b> <span class="muted">${esc(r.problem?.name || '')}</span></td>
            <td>${recordStatusChip(r)}</td>
            <td class="right num">${r.score}</td>
            <td class="right num">${esc(r.totalTime || '—')}</td>
            <td class="muted tiny">${esc(r.language || '—')}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : '<div class="muted">暂无提交记录</div>'}
      </div>
    `;
  }

  function renderStudents() {
    return state.studentId ? studentDetailHtml(state.studentId) : studentsHtml();
  }

  // ---------- Records ----------
  function filteredRecords() {
    let records = allRecords();
    if (state.recHw !== 'all') {
      const hw = findHw(state.recHw);
      if (hw) records = records.filter((r) => r.homework === hw.title);
    }
    if (state.recStudent !== 'all') records = records.filter((r) => Number(r.user?.uid) === Number(state.recStudent));
    if (state.recStatus === 'ac') records = records.filter((r) => r.status?.code === 'AC');
    else if (state.recStatus === 'fail') records = records.filter((r) => r.status?.code !== 'AC');
    const q = state.recSearch.trim().toLowerCase();
    if (q) {
      records = records.filter((r) => [r.user?.name, r.homework, r.problem?.pid, r.problem?.name, r.status?.code].join(' ').toLowerCase().includes(q));
    }
    return [...records].sort((a, b) => String(b.submitAt).localeCompare(String(a.submitAt)) || String(b.rid).localeCompare(String(a.rid)));
  }

  function pageButtons(totalPages, current) {
    const pages = [];
    const push = (n) => pages.push(`<button class="page-btn ${n === current ? 'active' : ''}" data-page="${n}">${n}</button>`);
    if (totalPages <= 9) {
      for (let i = 1; i <= totalPages; i++) push(i);
    } else {
      push(1);
      if (current > 4) pages.push('<span class="muted" style="padding:0 4px">…</span>');
      for (let i = Math.max(2, current - 2); i <= Math.min(totalPages - 1, current + 2); i++) push(i);
      if (current < totalPages - 3) pages.push('<span class="muted" style="padding:0 4px">…</span>');
      push(totalPages);
    }
    return pages.join('');
  }

  function recordsHtml() {
    const records = filteredRecords();
    const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    const page = Math.min(state.recPage, totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const pageRecords = records.slice(start, start + PAGE_SIZE);

    return `
      <div class="card">
        <div class="card-head">
          <div><h3 class="card-title">全部做题记录</h3><p class="card-sub">共 ${records.length} 条记录，点击任一行查看代码与评测详情</p></div>
          <button class="btn btn-soft btn-sm" data-action="export-csv">导出当前筛选 CSV</button>
        </div>
        <div class="records-toolbar">
          <select id="recHw" class="select">
            <option value="all" ${state.recHw === 'all' ? 'selected' : ''}>全部作业</option>
            ${allHomeworks().map((hw) => `<option value="${esc(hw.id)}" ${state.recHw === hw.id ? 'selected' : ''}>${esc(hw.title)}</option>`).join('')}
          </select>
          <select id="recStudent" class="select">
            <option value="all" ${state.recStudent === 'all' ? 'selected' : ''}>全部学员</option>
            ${allStudents().map((s) => `<option value="${s.uid}" ${Number(state.recStudent) === Number(s.uid) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
          <select id="recStatus" class="select">
            <option value="all" ${state.recStatus === 'all' ? 'selected' : ''}>全部状态</option>
            <option value="ac" ${state.recStatus === 'ac' ? 'selected' : ''}>仅通过</option>
            <option value="fail" ${state.recStatus === 'fail' ? 'selected' : ''}>仅未通过</option>
          </select>
          <div class="searchbox" style="flex:1;min-width:180px">
            <span class="search-icon">⌕</span>
            <input id="recSearch" type="text" value="${esc(state.recSearch)}" placeholder="搜索学员 / 题目 / 状态…" style="width:100%" />
          </div>
        </div>
        <div class="table-wrap tall">
          <table class="data">
            <thead><tr><th>提交时间</th><th>学员</th><th>作业</th><th>题目</th><th>状态</th><th class="right">分数</th><th class="right">耗时</th><th class="right">内存</th><th>语言</th></tr></thead>
            <tbody>
              ${pageRecords.map((r) => `<tr class="clickable" data-record="${esc(r.rid)}">
                <td class="muted tiny">${fmtDateTime(r.submitAt)}</td>
                <td><div class="user-cell">${avatar(r.user?.name)}<span class="name">${esc(r.user?.name || '')}</span></div></td>
                <td class="tiny">${esc(r.homework)}</td>
                <td><b class="mono" style="font-size:11px">${esc(r.problem?.pid || '')}</b> <span class="muted">${esc(r.problem?.name || '')}</span></td>
                <td>${recordStatusChip(r)}</td>
                <td class="right num"><b>${r.score}</b></td>
                <td class="right num">${esc(r.totalTime || '—')}</td>
                <td class="right num">${esc(r.peakMemory || '—')}</td>
                <td class="muted tiny">${esc(r.language || '—')}</td>
              </tr>`).join('') || '<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">没有符合条件的记录</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="pagination">
          <span class="muted tiny">第 ${page} / ${totalPages} 页 · 每页 ${PAGE_SIZE} 条</span>
          <div class="page-btns">
            <button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
            ${pageButtons(totalPages, page)}
            <button class="page-btn" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- Render root ----------
  function disposeCharts() {
    for (const chart of Object.values(state.charts)) {
      try { chart.dispose(); } catch { /* ignore */ }
    }
    state.charts = {};
  }

  function render() {
    disposeCharts();
    if (!state.data) {
      $('#filterbar').classList.add('hidden');
      $('#emptyState').classList.remove('hidden');
      $('#content').innerHTML = '';
      setSync(false);
      return;
    }
    $('#filterbar').classList.remove('hidden');
    $('#emptyState').classList.add('hidden');
    updateTabs();
    renderPills();
    setSync(state.scraping);

    let html = '';
    if (state.tab === 'overview') html = overviewHtml();
    else if (state.tab === 'homework') html = renderHomework();
    else if (state.tab === 'students') html = renderStudents();
    else if (state.tab === 'records') html = recordsHtml();
    $('#content').innerHTML = html;
    requestAnimationFrame(afterRender);
  }

  function afterRender() {
    if (state.tab === 'overview') {
      initTrendChart();
      initStatusChart();
    } else if (state.tab === 'students' && state.studentId) {
      initRadarChart();
    }
    if (state.tab === 'records') {
      const input = $('#recSearch');
      if (input && document.activeElement !== input && state.recFocus) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        state.recFocus = false;
      }
    }
  }

  // ---------- Charts ----------
  function baseText() {
    return { color: '#64748b', fontFamily: 'Microsoft YaHei, PingFang SC, sans-serif', fontSize: 11 };
  }

  function initChart(id, option) {
    const el = document.getElementById(id);
    if (!el || !window.echarts) return;
    const chart = window.echarts.init(el);
    chart.setOption({ animation: false, ...option });
    state.charts[id] = chart;
  }

  function initTrendChart() {
    const hws = allHomeworks();
    const data = hws.map((hw) => pctNum(summarizeHw(hw).completion));
    const submitted = hws.map((hw) => summarizeHw(hw).submittedStudents);
    initChart('chartTrend', {
      grid: { left: 12, right: 18, top: 42, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(15,23,42,.92)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 11 },
        axisPointer: { type: 'shadow' },
      },
      legend: { top: 0, right: 0, textStyle: baseText(), itemWidth: 10, itemHeight: 10 },
      xAxis: {
        type: 'category',
        data: hws.map((hw) => hwShort(hw.title)),
        axisLine: { lineStyle: { color: '#e2e8f0' } },
        axisTick: { show: false },
        axisLabel: { ...baseText(), interval: 0 },
      },
      yAxis: [
        { type: 'value', max: 100, axisLabel: { ...baseText(), formatter: '{value}%' }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
        { type: 'value', minInterval: 1, axisLabel: baseText(), splitLine: { show: false } },
      ],
      series: [
        {
          name: '平均完成率',
          type: 'bar',
          data,
          barWidth: 26,
          itemStyle: {
            borderRadius: [7, 7, 0, 0],
            color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: '#818cf8' },
              { offset: 1, color: '#4f46e5' },
            ]),
          },
          label: { show: true, position: 'top', formatter: (p) => (p.value ? `${p.value}%` : ''), color: '#4f46e5', fontWeight: 700, fontSize: 10 },
        },
        {
          name: '提交人数',
          type: 'line',
          yAxisIndex: 1,
          data: submitted,
          smooth: true,
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { width: 3, color: '#f59e0b' },
          itemStyle: { color: '#f59e0b', borderColor: '#fff', borderWidth: 2 },
          label: { show: true, position: 'bottom', formatter: (p) => (p.value ? `${p.value} 人` : ''), color: '#b45309', fontSize: 10 },
        },
      ],
    });
  }

  function initStatusChart() {
    const g = globalStats();
    initChart('chartStatus', {
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(15,23,42,.92)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 11 },
        formatter: '{b}<br/>{c} 题次 · {d}%',
      },
      legend: { bottom: 4, left: 'center', textStyle: baseText(), itemWidth: 10, itemHeight: 10 },
      series: [{
        type: 'pie',
        radius: ['52%', '76%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 3 },
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 15, fontWeight: 800, formatter: '{d}%' } },
        data: [
          { name: '通过', value: g.ac, itemStyle: { color: '#10b981' } },
          { name: '未通过', value: g.attempted, itemStyle: { color: '#f59e0b' } },
          { name: '未提交', value: g.none, itemStyle: { color: '#e2e8f0' } },
        ],
      }],
      graphic: [
        { type: 'text', left: 'center', top: '39%', style: { text: String(g.totalCells), fill: '#0f172a', fontSize: 25, fontWeight: 800, fontFamily: 'Microsoft YaHei' } },
        { type: 'text', left: 'center', top: '49%', style: { text: '题次', fill: '#94a3b8', fontSize: 10, fontFamily: 'Microsoft YaHei' } },
      ],
    });
  }

  function initRadarChart() {
    const hws = activeHomeworks();
    const uid = state.studentId;
    if (!hws.length || !uid) return;
    const values = hws.map((hw) => pctNum(summarizeStudent(uid, hw).completion));
    initChart('chartRadar', {
      tooltip: { backgroundColor: 'rgba(15,23,42,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 11 } },
      radar: {
        indicator: hws.map((hw) => ({ name: hwShort(hw.title), max: 100 })),
        radius: '64%',
        splitNumber: 4,
        axisName: { ...baseText(), color: '#475569', fontSize: 11 },
        splitArea: { areaStyle: { color: ['rgba(99,102,241,.03)', 'rgba(99,102,241,.06)'] } },
        splitLine: { lineStyle: { color: '#e2e8f0' } },
        axisLine: { lineStyle: { color: '#e2e8f0' } },
      },
      series: [{
        type: 'radar',
        data: [{
          value: values,
          name: studentName(uid),
          symbolSize: 6,
          lineStyle: { width: 2, color: '#6366f1' },
          itemStyle: { color: '#6366f1' },
          areaStyle: { color: 'rgba(99,102,241,.18)' },
          label: { show: true, formatter: '{c}%', color: '#4f46e5', fontSize: 10, fontWeight: 700 },
        }],
      }],
    });
  }

  // ---------- Drawer ----------
  function openRecord(rid) {
    const record = allRecords().find((r) => r.rid === rid);
    if (!record) return;
    $('#drawerTitle').innerHTML = `${recordStatusChip(record)} <span class="mono" style="font-size:13px">${esc(record.problem?.pid || '')}</span> ${esc(record.problem?.name || '')}`;
    $('#drawerSub').textContent = `${record.user?.name || ''} · ${record.homework || ''} · ${record.submitText || fmtDateTime(record.submitAt)}`;
    const tone = recordTone(record.status?.code);
    $('#drawerBody').innerHTML = `
      <div class="meta-grid">
        <div class="meta-item"><span>状态</span><b><span class="status-chip ${tone}">${esc(record.status?.code || '—')} ${esc(record.status?.label || '')}</span></b></div>
        <div class="meta-item"><span>分数</span><b>${record.score}</b></div>
        <div class="meta-item"><span>总耗时</span><b>${esc(record.totalTime || '—')}</b></div>
        <div class="meta-item"><span>峰值内存</span><b>${esc(record.peakMemory || '—')}</b></div>
        <div class="meta-item"><span>语言</span><b>${esc(record.language || '—')}</b></div>
        <div class="meta-item"><span>代码长度</span><b>${esc(record.codeLength || '—')}</b></div>
        <div class="meta-item"><span>递交时间</span><b>${esc(record.submitText || fmtDateTime(record.submitAt))}</b></div>
        <div class="meta-item"><span>评测时间</span><b>${esc(record.judgeText || fmtDateTime(record.judgeAt))}</b></div>
      </div>
      <div class="section-h">提交代码 <span class="line"></span><span class="tiny muted">${esc(record.language || '')}</span></div>
      <div class="code-block">
        <div class="code-head"><span>${esc(record.problem?.pid || '')}.${esc(record.problem?.name || '')}</span><button data-action="copy-code" data-rid="${esc(record.rid)}">复制代码</button></div>
        <pre id="drawerCode"></pre>
      </div>
      ${(record.cases || []).length ? `<div class="section-h">测试点 <span class="line"></span><span class="tiny muted">${record.cases.length} 个</span></div>
        <div class="table-wrap"><table class="data case-table">
          <thead><tr><th>#</th><th>状态</th><th class="right">耗时</th><th class="right">内存</th></tr></thead>
          <tbody>${record.cases.map((c, i) => `<tr><td class="muted num">${i + 1}</td><td><span class="status-chip ${recordTone(c.status?.code)}">${esc(c.status?.code || '—')}</span></td><td class="right num">${esc(c.time || '—')}</td><td class="right num">${esc(c.memory || '—')}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
      <div style="margin-top:18px;display:flex;gap:9px;flex-wrap:wrap">
        <a class="btn btn-soft btn-sm" href="https://marsoj.cn/new/record/${esc(record.rid)}" target="_blank" rel="noreferrer">在 MarsOJ 打开 ↗</a>
        <button class="btn btn-soft btn-sm" data-student="${record.user?.uid}">查看该学员 →</button>
      </div>
    `;
    const code = $('#drawerCode');
    if (code) code.textContent = record.code || '（无代码）';
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawerOverlay').classList.add('open');
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#drawerOverlay').classList.remove('open');
  }

  // ---------- Progress ----------
  const PHASE_NAMES = {
    starting: '准备抓取',
    login: '登录 MarsOJ',
    list: '检索作业',
    homework: '读取作业与成绩表',
    records: '抓取做题记录',
    done: '完成',
  };

  function updateProgress(progress) {
    if (!progress) return;
    state.progress = progress;
    const phase = progress.phase || 'starting';
    const total = Number(progress.total) || 0;
    const current = Number(progress.current) || 0;
    const pctValue = total ? Math.min(100, Math.round((current / total) * 100)) : (phase === 'done' ? 100 : 0);
    $('#progressTitle').textContent = phase === 'done' ? '抓取完成' : `正在${PHASE_NAMES[phase] || '抓取'}…`;
    $('#progressMsg').textContent = progress.message || '请稍候…';
    $('#progressBar').style.width = `${pctValue}%`;
    $('#progressCount').textContent = total ? `${current} / ${total}` : '';
    $('#progressPct').textContent = `${pctValue}%`;
    $('#progressLog').textContent = progress.message || '';
    if (phase === 'done') {
      $('#progressSpinner').style.display = 'none';
    } else {
      $('#progressSpinner').style.display = 'inline-block';
    }
  }

  function openProgress(progress) {
    $('#progressOverlay').classList.remove('hidden');
    $('#progressClose').classList.add('hidden');
    $('#progressSpinner').style.display = 'inline-block';
    if (progress) updateProgress(progress);
  }

  function closeProgress() {
    $('#progressOverlay').classList.add('hidden');
  }

  function setupStaticUi() {
    $('#refreshBtn').innerHTML = '<span id="refreshIcon">↻</span> 刷新页面数据';
    const bannerButton = $('#newBanner [data-action="refresh"]');
    if (bannerButton) bannerButton.classList.add('hidden');
  }

  async function startScrape() {
    if (STATIC) {
      const ok = await loadData();
      if (ok) {
        render();
        showToast('已加载 GitHub Pages 最新发布数据');
      } else {
        showToast('数据加载失败，请稍后刷新页面', true);
      }
      return;
    }
    if (state.scraping) {
      openProgress(state.progress);
      return;
    }
    setRefreshBusy(true);
    openProgress({ phase: 'starting', message: '正在启动抓取任务…', current: 0, total: 0 });
    try {
      const response = await fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) });
      if (response.status === 409) {
        const running = await fetch('/api/state', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
        if (running?.running) {
          applyState(running);
          showToast('已有抓取任务，正在同步进度');
        } else {
          setRefreshBusy(false);
          closeProgress();
          showToast('已有抓取任务正在进行，请稍候');
        }
        return;
      }
      if (!response.ok) throw new Error('启动失败');
    } catch (error) {
      setRefreshBusy(false);
      closeProgress();
      showToast(`抓取启动失败：${error.message}`, true);
    }
  }

  // ---------- Banner / toast ----------
  function dismissedNew() {
    try { return JSON.parse(localStorage.getItem('dismissedNew') || '[]'); } catch { return []; }
  }

  function showNewBanner(list) {
    const dismissed = dismissedNew();
    const fresh = (list || []).filter((h) => !dismissed.includes(h.id));
    if (!fresh.length) return;
    $('#newBannerText').innerHTML = `检测到 <b>${fresh.length}</b> 个新作业：<b>${fresh.map((h) => esc(h.title)).join('、')}</b>。可立即抓取，补齐学员、逐题状态与做题记录。`;
    $('#newBanner').classList.remove('hidden');
    $('#newBanner').dataset.ids = JSON.stringify(fresh.map((h) => h.id));
  }

  function dismissNewBanner() {
    const banner = $('#newBanner');
    try {
      const ids = JSON.parse(banner.dataset.ids || '[]');
      const next = [...new Set([...dismissedNew(), ...ids])];
      localStorage.setItem('dismissedNew', JSON.stringify(next));
    } catch { /* ignore */ }
    banner.classList.add('hidden');
  }

  let toastTimer = null;
  function showToast(message, isError = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3800);
  }

  // ---------- Data / SSE ----------
  async function loadData() {
    const endpoint = STATIC ? staticUrl('data.json') : '/api/data';
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) {
      state.data = null;
      return false;
    }
    state.data = await response.json();
    return true;
  }

  function applyNewHomeworks(list) {
    if (!list || !list.length) return;
    state.newHomeworks = list;
    showNewBanner(list);
  }

  function applyState(s) {
    if (!s) return;
    state.lastCheck = s.lastCheck;
    if (s.lastCheck) $('#lastCheck').textContent = `上次检测 ${fmtDateTime(s.lastCheck)}`;
    if (s.running) {
      state.scraping = true;
      setRefreshBusy(true);
      openProgress(s.progress);
    } else {
      state.scraping = false;
      setRefreshBusy(false);
    }
    applyNewHomeworks(s.newHomeworks);
  }

  function connectEvents() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/events');
    es.addEventListener('state', (event) => {
      try { applyState(JSON.parse(event.data)); } catch { /* ignore */ }
    });
    es.addEventListener('progress', (event) => {
      try {
        const p = JSON.parse(event.data);
        state.scraping = true;
        setRefreshBusy(true);
        openProgress(p);
      } catch { /* ignore */ }
    });
    es.addEventListener('done', async (event) => {
      try {
        const payload = JSON.parse(event.data);
        updateProgress({ phase: 'done', message: '数据已更新，正在刷新看板…', current: 1, total: 1 });
        await loadData();
        state.scraping = false;
        state.newHomeworks = [];
        $('#newBanner').classList.add('hidden');
        setRefreshBusy(false);
        render();
        setTimeout(closeProgress, 700);
        showToast(`抓取完成：${payload?.stats?.homeworkCount ?? allHomeworks().length} 次作业，${payload?.stats?.recordCount ?? allRecords().length} 条记录`);
      } catch (error) {
        setRefreshBusy(false);
        closeProgress();
        showToast(`刷新数据失败：${error.message}`, true);
      }
    });
    es.addEventListener('error', (event) => {
      try {
        const payload = JSON.parse(event.data);
        setRefreshBusy(false);
        $('#progressTitle').textContent = '抓取失败';
        $('#progressMsg').textContent = payload.message || '请稍后重试';
        $('#progressSpinner').style.display = 'none';
        $('#progressClose').classList.remove('hidden');
        showToast(`抓取失败：${payload.message}`, true);
      } catch { /* ignore */ }
    });
    es.addEventListener('new-homeworks', (event) => {
      try { applyNewHomeworks(JSON.parse(event.data).newHomeworks); } catch { /* ignore */ }
    });
    es.addEventListener('check', (event) => {
      try {
        const payload = JSON.parse(event.data);
        state.lastCheck = payload.checkedAt;
        $('#lastCheck').textContent = `上次检测 ${fmtDateTime(payload.checkedAt)}`;
      } catch { /* ignore */ }
    });
  }

  // ---------- CSV ----------
  function exportCsv() {
    const records = filteredRecords();
    const header = ['提交时间', '学员', 'UID', '作业', '题目', '状态', '分数', '耗时', '内存', '语言', '记录ID'];
    const rows = records.map((r) => [
      fmtDateTime(r.submitAt),
      r.user?.name || '',
      r.user?.uid || '',
      r.homework || '',
      `${r.problem?.pid || ''} ${r.problem?.name || ''}`.trim(),
      `${r.status?.code || ''} ${r.status?.label || ''}`.trim(),
      r.score,
      r.totalTime || '',
      r.peakMemory || '',
      r.language || '',
      r.rid,
    ]);
    const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = '\ufeff' + [header, ...rows].map((row) => row.map(quote).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `高潜做题记录_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已导出 ${records.length} 条记录`);
  }

  // ---------- Events ----------
  function switchTab(tab) {
    state.tab = tab;
    if (tab !== 'students') state.studentId = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function selectHomework(id) {
    state.hwId = id;
    if (state.tab === 'records') {
      state.recHw = id;
      state.recPage = 1;
      render();
      return;
    }
    if (id === 'all') {
      if (state.tab === 'homework') state.tab = 'overview';
    } else {
      state.tab = 'homework';
      state.studentId = null;
    }
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action],[data-tab],[data-hw],[data-student],[data-record],[data-page]');
    if (!target) return;

    if (target.dataset.tab) {
      switchTab(target.dataset.tab);
      return;
    }
    if (target.dataset.action) {
      const action = target.dataset.action;
      if (action === 'refresh') startScrape();
      else if (action === 'dismiss-banner') dismissNewBanner();
      else if (action === 'close-drawer') closeDrawer();
      else if (action === 'close-progress') closeProgress();
      else if (action === 'back-homework') { state.hwId = 'all'; state.tab = 'homework'; render(); }
      else if (action === 'back-students') { state.studentId = null; render(); }
      else if (action === 'records-student') { state.recStudent = state.studentId; state.recPage = 1; state.tab = 'records'; state.studentId = null; render(); }
      else if (action === 'export-csv') exportCsv();
      else if (action === 'copy-code') {
        const record = allRecords().find((r) => r.rid === target.dataset.rid);
        if (record?.code) {
          navigator.clipboard?.writeText(record.code).then(() => showToast('代码已复制')).catch(() => showToast('复制失败，请手动选择', true));
        }
      }
      return;
    }
    if (target.dataset.record) {
      openRecord(target.dataset.record);
      return;
    }
    if (target.dataset.student) {
      closeDrawer();
      state.studentId = Number(target.dataset.student);
      state.tab = 'students';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (target.dataset.hw !== undefined) {
      selectHomework(target.dataset.hw);
      return;
    }
    if (target.dataset.page) {
      const page = Number(target.dataset.page);
      if (page >= 1) {
        state.recPage = page;
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  });

  document.addEventListener('change', (event) => {
    const id = event.target.id;
    if (id === 'recHw') { state.recHw = event.target.value; state.hwId = event.target.value; state.recPage = 1; render(); }
    else if (id === 'recStudent') { state.recStudent = event.target.value; state.recPage = 1; render(); }
    else if (id === 'recStatus') { state.recStatus = event.target.value; state.recPage = 1; render(); }
  });

  let searchTimer = null;
  document.addEventListener('input', (event) => {
    if (event.target.id === 'studentSearch') {
      state.search = event.target.value;
      render();
    } else if (event.target.id === 'recSearch') {
      state.recSearch = event.target.value;
      state.recPage = 1;
      state.recFocus = true;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(render, 220);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });

  window.addEventListener('resize', () => {
    for (const chart of Object.values(state.charts)) {
      try { chart.resize(); } catch { /* ignore */ }
    }
  });

  // ---------- Init ----------
  async function init() {
    if (!NO_EVENTS) connectEvents();
    if (STATIC) setupStaticUi();
    let startup = null;
    try {
      const stateEndpoint = STATIC ? staticUrl('state.json') : '/api/state';
      startup = await fetch(stateEndpoint, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
    } catch { /* ignore */ }
    if (startup) applyState(startup);

    const ok = await loadData();
    if (!ok) {
      setSync(false);
      $('#filterbar').classList.add('hidden');
      $('#emptyState').classList.remove('hidden');
      return;
    }

    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (['overview', 'homework', 'students', 'records'].includes(tab)) state.tab = tab;
    const hwParam = params.get('hw');
    if (hwParam && findHw(hwParam)) {
      state.hwId = hwParam;
      if (!tab) state.tab = 'homework';
    }
    const studentParam = params.get('student');
    if (studentParam && allStudents().some((s) => Number(s.uid) === Number(studentParam))) {
      state.studentId = Number(studentParam);
      state.tab = 'students';
    }
    const recHwParam = params.get('recHw');
    if (recHwParam && findHw(recHwParam)) state.recHw = recHwParam;
    const recStatusParam = params.get('recStatus');
    if (['all', 'ac', 'fail'].includes(recStatusParam)) state.recStatus = recStatusParam;

    render();
    const recordParam = params.get('record');
    if (recordParam) setTimeout(() => openRecord(recordParam), 180);
    const newOnes = allHomeworks().filter((h) => h.isNew);
    if (newOnes.length && !STATIC) showNewBanner(newOnes);
    if (NO_EVENTS) return;
    try {
      const check = await fetch('/api/check', { cache: 'no-store' }).then((r) => r.json());
      if (check?.newCount) applyNewHomeworks(check.newHomeworks);
      if (check?.checkedAt) {
        state.lastCheck = check.checkedAt;
        $('#lastCheck').textContent = `上次检测 ${fmtDateTime(check.checkedAt)}`;
      }
    } catch { /* ignore */ }
  }

  init();
})();
