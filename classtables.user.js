// ==UserScript==
// @name         北交大课表导出 (ICS / CSV / JSON)
// @namespace    https://github.com/bjtu-timetable-export
// @version      1.0.0
// @description  从北交大一体化智慧教学平台的"我的课表"页面导出整学期课程表为 ICS 日历 / CSV / JSON
// @author       zhangshixiao
// @match        http://123.121.147.7:88/ve/back/rp/common/myTimeTableDetail.shtml*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 说明
 * ----
 * 该页面每次只渲染"一周"的课表，周的起止日期由页面上 #jxzId 下拉框给出。
 * 因为学校的周次是按节假日重排过的（例如第3周结束于 09-27，第4周从 10-05 开始，
 * 中间是国庆假期），所以"第N周星期几"对应的真实日期必须取自页面的周次列表，
 * 不能按"第一周周一 + (N-1)*7"去推算。
 *
 * 因此本脚本会：
 *   1. 先从 #jxzId 解析出每个周的起止日期；
 *   2. 逐周抓取同源页面（浏览器已登录，cookie 自动带上），解析出每一节课；
 *   3. 用"该周的真实周一 + (星期几-1)"得到每次课的真实日期；
 *   4. 导出为 ICS / CSV / JSON。
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------

  // 标准节次（页面只渲染"有课"的行，且上午存在 10:10 / 10:30 两种作息，
  // 因此节次号由行首时间落到哪个标准节次来判定，而不是行下标）。
  const PERIODS = [
    { no: 1, start: '08:00', end: '09:50' },
    { no: 2, start: '10:10', end: '12:00' },
    { no: 3, start: '12:10', end: '14:00' },
    { no: 4, start: '14:10', end: '16:00' },
    { no: 5, start: '16:20', end: '18:10' },
    { no: 6, start: '19:00', end: '20:50' },
    { no: 7, start: '21:00', end: '21:50' }
  ];

  const WEEKDAY_CN = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  const pad2 = (n) => String(n).padStart(2, '0');
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  /** 行首时间 -> 标准节次号（取起始时间不大于它的最后一个标准节次） */
  function periodNo(start) {
    const v = toMin(start);
    let no = 1;
    for (const p of PERIODS) {
      if (v >= toMin(p.start)) no = p.no;
    }
    return no;
  }

  function ymd(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  function hm(d) {
    return pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  /** '2026-09-07' -> Date（本地零点） */
  function parseDate(s) {
    const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  function addDays(d, n) {
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  // ---------------------------------------------------------------------------
  // 解析页面
  // ---------------------------------------------------------------------------

  /** 从 #jxzId 解析周次 -> 起止日期。 */
  function parseWeeks() {
    const out = [];
    const sel = document.querySelector('#jxzId');
    if (sel) {
      for (const opt of sel.options) {
        const t = opt.textContent || '';
        const m = t.match(/第\s*(\d+)\s*周[^0-9]*?(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})/);
        if (m) {
          out.push({ week: +m[1], start: m[2], end: m[3], hasClass: /有课/.test(t) });
        }
      }
    }
    if (out.length) return out;

    // 兜底：整页文本里正则
    const txt = document.body ? document.body.innerText : '';
    const re = /第\s*(\d+)\s*周\s*(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})/g;
    let m;
    while ((m = re.exec(txt))) {
      out.push({ week: +m[1], start: m[2], end: m[3], hasClass: true });
    }
    return out;
  }

  /** 当前页面 URL 中的 sessionId */
  function currentSessionId() {
    const m = location.search.match(/sessionId=([^&]+)/);
    return m ? m[1] : '';
  }

  /**
   * 解析一周的 HTML，返回该周所有课次。
   * 页面结构：ul.timetable-tabletlist
   *   li.table-list            -> 该行时间标签   10:10- 12:00
   *   li.table-list2           -> 一个格子（每天一个）
   *       span.table-t         -> 课程：xxx
   *       span.table-b         -> 教师：xxx / 班级：xxx
   *       span.table-m         -> 学生：xxx
   *       span.table-j         -> 教室：xxx
   */
  function parseWeekHtml(html, week) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // 表头的 7 天
    const headUl = [...doc.querySelectorAll('ul')].find((u) => u.querySelector('.time-week'));
    const days = [];
    if (headUl) {
      for (const li of headUl.children) {
        const w = li.querySelector('.time-week');
        const d = li.querySelector('.time-day');
        if (!w) continue;
        const wk = w.textContent.trim();
        const idx = WEEKDAY_CN.indexOf(wk);
        if (idx < 0) continue;
        days.push({ weekday: idx + 1, date: d ? d.textContent.trim() : '' });
      }
    }

    const out = [];
    // 注意：每个"节次"是一个独立的 <ul class="timetable-tabletlist">，
    // 里面第一个 li.table-list 是时间标签，其余 li.table-list2 是 7 个格子。
    const grids = doc.querySelectorAll('ul.timetable-tabletlist');
    for (const grid of grids) {
      let rowTime = null;
      let col = -1;
      for (const li of grid.children) {
        if (li.classList.contains('table-list')) {
          const sp = li.querySelector('.table-listsp1');
          const t = sp ? sp.textContent.trim() : '';
          const m = t.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
          rowTime = m ? { start: m[1], end: m[2] } : null;
          col = -1;
          continue;
        }
        if (li.classList.contains('table-list2')) {
          col++;
          const tEl = li.querySelector('.table-t');
          if (!tEl) continue;                       // 空格子
          if (!rowTime || col < 0 || col >= days.length) continue;

          const name = cleanPrefix(tEl.textContent, '课程：');
          if (!name) continue;

          let teacher = '';
          const bs = li.querySelectorAll('.table-b');
          for (const b of bs) {
            const s = b.textContent.trim();
            if (s.startsWith('教师：')) teacher = cleanPrefix(s, '教师：');
          }
          const jEl = li.querySelector('.table-j');
          const room = jEl ? cleanPrefix(jEl.textContent, '教室：') : '';

          out.push({
            week,
            weekday: days[col].weekday,
            dateStr: days[col].date,
            period: periodNo(rowTime.start),
            start: rowTime.start,
            end: rowTime.end,
            name,
            teacher,
            room
          });
        }
      }
    }
    return { days, courses: out };
  }

  function cleanPrefix(s, prefix) {
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    if (prefix && t.startsWith(prefix)) t = t.slice(prefix.length);
    return t.trim();
  }

  // ---------------------------------------------------------------------------
  // 抓取全部周次
  // ---------------------------------------------------------------------------

  /**
   * 逐周抓取。页面是 GBK 编码，必须用 TextDecoder('gbk') 解码，
   * 否则中文会乱码。
   */
  async function fetchAllWeeks(onProgress) {
    const weeks = parseWeeks();
    if (!weeks.length) throw new Error('页面未找到周次列表（#jxzId）');

    const sid = currentSessionId();
    const base = location.pathname;
    const all = [];
    const dayMap = {};

    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i];
      onProgress && onProgress(i + 1, weeks.length, w.week);

      const url =
        base +
        '?method=skipIndex&flag=' + encodeURIComponent(w.week) +
        '&begin_time=' + encodeURIComponent(w.start) +
        '&sessionId=' + encodeURIComponent(sid);

      let html;
      if (w.week === currentWeekNo(weeks)) {
        // 当前周已经在页面上渲染好了，直接复用，省一次请求
        html = document.documentElement.outerHTML;
      } else {
        const resp = await fetch(url, { credentials: 'same-origin' });
        const buf = await resp.arrayBuffer();
        html = decodeGbk(buf);
      }

      const parsed = parseWeekHtml(html, w.week);
      dayMap[w.week] = parsed.days;
      for (const c of parsed.courses) all.push(c);
    }
    return { weeks, courses: all, dayMap };
  }

  function currentWeekNo(weeks) {
    const sel = document.querySelector('#jxzId');
    if (sel && sel.value) {
      const v = parseInt(sel.value, 10);
      if (!isNaN(v)) return v;
    }
    return weeks.length ? weeks[0].week : -1;
  }

  function decodeGbk(buf) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch (e) {
      // 极少数环境不支持 gbk，退回 utf-8
      return new TextDecoder('utf-8').decode(buf);
    }
  }

  // ---------------------------------------------------------------------------
  // 归组：把"每周重复的同一节课"合并成一条
  // ---------------------------------------------------------------------------

  function group(courses, weeks) {
    const byWeek = new Map();
    for (const w of weeks) byWeek.set(w.week, w);

    const map = new Map();
    for (const c of courses) {
      const key = [c.name, c.weekday, c.period, c.room].join('\u0001');
      let g = map.get(key);
      if (!g) {
        g = {
          name: c.name,
          weekday: c.weekday,
          period: c.period,
          room: c.room,
          start: c.start,
          end: c.end,
          weeks: [],
          teachers: []
        };
        map.set(key, g);
      }
      if (!g.weeks.includes(c.week)) g.weeks.push(c.week);
      if (c.teacher && !g.teachers.includes(c.teacher)) g.teachers.push(c.teacher);
    }

    const out = [...map.values()];
    for (const g of out) {
      g.weeks.sort((a, b) => a - b);
      g.teacher = g.teachers.join(',');
    }
    out.sort((a, b) => a.weekday - b.weekday || a.period - b.period || a.name.localeCompare(b.name));
    return out;
  }

  /** 周次数组 -> "第01-16周" / "第01-03,05-16周"（把连续段压缩成 a-b） */
  function weeksLabel(ws) {
    if (!ws.length) return '';
    const w = ws.slice().sort((a, b) => a - b);
    const parts = [];
    let start = w[0];
    let prev = w[0];
    for (let i = 1; i < w.length; i++) {
      if (w[i] === prev + 1) {
        prev = w[i];
        continue;
      }
      parts.push(start === prev ? pad2(start) : pad2(start) + '-' + pad2(prev));
      start = prev = w[i];
    }
    parts.push(start === prev ? pad2(start) : pad2(start) + '-' + pad2(prev));
    // 单周次直接写 "第03周"，多段写 "第01-03,05-16周"
    return '第' + parts.join(',') + '周';
  }

  /** 某周星期几的真实日期：该周周一 + (weekday-1) */
  function dateOf(weekMeta, weekday) {
    const mon = parseDate(weekMeta.start);
    if (!mon) return null;
    return addDays(mon, weekday - 1);
  }

  // ---------------------------------------------------------------------------
  // 生成三种输出
  // ---------------------------------------------------------------------------

  function buildICS(groups, weeks) {
    const byWeek = new Map(weeks.map((w) => [w.week, w]));
    const stamp = ymd(new Date()) + 'T' + hm(new Date());
    const lines = ['BEGIN:VCALENDAR', 'PRODID:-//classtables//user.js//CN', 'VERSION:2.0', 'CALSCALE:GREGORIAN'];

    let uid = 0;
    const evs = [];
    for (const g of groups) {
      for (const w of g.weeks) {
        const meta = byWeek.get(w);
        if (!meta) continue;
        const day = dateOf(meta, g.weekday);
        if (!day) continue;
        const [sh, sm] = g.start.split(':').map(Number);
        const [eh, em] = g.end.split(':').map(Number);
        const dtStart = new Date(day.getTime());
        dtStart.setHours(sh, sm, 0, 0);
        const dtEnd = new Date(day.getTime());
        dtEnd.setHours(eh, em, 0, 0);
        evs.push({ g, dtStart, dtEnd, w });
      }
    }
    evs.sort((a, b) => a.dtStart - b.dtStart);

    for (const ev of evs) {
      const g = ev.g;
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + uid++ + '@classtables');
      lines.push('DTSTAMP;VALUE=DATE-TIME:' + stamp);
      lines.push('DTSTART;VALUE=DATE-TIME:' + ymd(ev.dtStart) + 'T' + hm(ev.dtStart));
      lines.push('DTEND;VALUE=DATE-TIME:' + ymd(ev.dtEnd) + 'T' + hm(ev.dtEnd));
      lines.push('CLASS:PUBLIC');
      lines.push('TRANSP:TRANSPARENT');
      lines.push('SUMMARY;LANGUAGE=zh-cn:' + icsEsc(g.name));
      if (g.room) lines.push('LOCATION:' + icsEsc(g.room));
      const desc = [g.room, weeksLabel(g.weeks), g.teacher && '任课教师：' + g.teacher]
        .filter(Boolean)
        .join(' ');
      if (desc) lines.push('DESCRIPTION:' + icsEsc(desc));
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function icsEsc(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /** 与 samples/课程表.csv 同构：表头 + 每行"第N节 [起 - 止]" */
  function buildCSV(groups) {
    const rows = [];
    rows.push('课程|星期,' + WEEKDAY_CN.join(','));

    const grid = new Map();
    for (const g of groups) {
      const key = g.period + '\u0001' + g.weekday;
      const cell = [g.name, weeksLabel(g.weeks), g.room, g.teacher].filter(Boolean).join(' ');
      grid.set(key, grid.has(key) ? grid.get(key) + ' | ' + cell : cell);
    }

    for (let p = 1; p <= PERIODS.length; p++) {
      const label = '第' + cnNum(p) + '节 [' + PERIODS[p - 1].start + ' - ' + PERIODS[p - 1].end + ']';
      let line = label;
      for (let w = 1; w <= 7; w++) line += ',\t' + (grid.get(p + '\u0001' + w) || '');
      line += ',';
      rows.push(line);
    }
    return rows.join('\r\n');
  }

  function cnNum(n) {
    return ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n - 1] || String(n);
  }

  /** 与 samples/课程表.json 同构 */
  function buildJSON(groups) {
    const arr = groups.map((g) => {
      const init = weeksLabel(g.weeks);
      return {
        weekNum: g.weekday,
        courseNum: g.period,
        name: g.name,
        location: g.room,
        initInfo: init,
        date: g.weeks.slice(),
        teacher: g.teacher,
        allInfo: [g.name, init, g.room, g.teacher].filter(Boolean).join(' ')
      };
    });
    arr.sort((a, b) => a.weekNum - b.weekNum || a.courseNum - b.courseNum);
    return JSON.stringify(arr);
  }

  // ---------------------------------------------------------------------------
  // 下载
  // ---------------------------------------------------------------------------

  function download(filename, text, mime) {
    // 加 BOM：Excel / Outlook 才会按 UTF-8 解析中文
    const blob = new Blob(['﻿', text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // 界面
  // ---------------------------------------------------------------------------

  const CSS = `
#ct-panel{position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#fff;
 border:1px solid #d0d7de;border-radius:10px;padding:12px 14px;width:248px;
 box-shadow:0 6px 24px rgba(0,0,0,.18);color:#24292f;
 font:13px/1.6 "Microsoft YaHei",system-ui,-apple-system,sans-serif}
#ct-panel .ct-hd{font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
#ct-panel .ct-count{font-weight:400;color:#6e7781;font-size:12px}
#ct-panel .ct-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
#ct-panel button{flex:1 1 auto;padding:6px 8px;border:1px solid #d0d7de;border-radius:6px;
 background:#f6f8fa;cursor:pointer;font:inherit;white-space:nowrap;color:#24292f}
#ct-panel button:hover:not(:disabled){background:#eaeef2}
#ct-panel button:disabled{opacity:.55;cursor:default}
#ct-panel .ct-msg{margin-top:8px;font-size:12px;color:#57606a;min-height:1.2em;word-break:break-all}
#ct-panel .ct-msg.ok{color:#1a7f37}
#ct-panel .ct-msg.err{color:#cf222e}
#ct-panel .ct-bar{height:4px;background:#eaeef2;border-radius:3px;margin-top:8px;overflow:hidden}
#ct-panel .ct-bar>i{display:block;height:100%;width:0;background:#2da44e;transition:width .2s}
`;

  function mount() {
    if (document.getElementById('ct-panel')) return;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'ct-panel';
    panel.innerHTML = `
      <div class="ct-hd"><span>课表导出</span><span class="ct-count" id="ct-count"></span></div>
      <div class="ct-btns">
        <button id="ct-load">抓取全学期</button>
      </div>
      <div class="ct-btns">
        <button id="ct-ics" disabled>导出 ICS</button>
        <button id="ct-csv" disabled>导出 CSV</button>
        <button id="ct-json" disabled>导出 JSON</button>
      </div>
      <div class="ct-bar"><i id="ct-prog"></i></div>
      <div class="ct-msg" id="ct-msg"></div>
    `;
    document.body.appendChild(panel);

    const $ = (id) => panel.querySelector(id);
    const msg = (t, kind) => {
      const el = $('#ct-msg');
      el.className = 'ct-msg' + (kind ? ' ' + kind : '');
      el.textContent = t;
    };

    let state = { groups: null, weeks: null };

    $('#ct-load').onclick = async () => {
      const btn = $('#ct-load');
      btn.disabled = true;
      msg('正在抓取各周课表…');
      try {
        const res = await fetchAllWeeks((i, n, w) => {
          $('#ct-prog').style.width = Math.round((i / n) * 100) + '%';
          msg(`抓取中 ${i}/${n}（第${w}周）`);
        });
        state.weeks = res.weeks;
        state.groups = group(res.courses, res.weeks);
        $('#ct-count').textContent = state.groups.length + ' 门次';
        msg(`完成：${res.weeks.length} 周，${res.courses.length} 次课，归并为 ${state.groups.length} 条`, 'ok');
        $('#ct-ics').disabled = $('#ct-csv').disabled = $('#ct-json').disabled = false;
      } catch (e) {
        console.error(e);
        msg('抓取失败：' + e.message, 'err');
      } finally {
        btn.disabled = false;
      }
    };

    $('#ct-ics').onclick = () => {
      download('课表.ics', buildICS(state.groups, state.weeks), 'text/calendar');
      msg('已导出 ICS', 'ok');
    };
    $('#ct-csv').onclick = () => {
      download('课程表.csv', buildCSV(state.groups), 'text/csv');
      msg('已导出 CSV', 'ok');
    };
    $('#ct-json').onclick = () => {
      download('课程表.json', buildJSON(state.groups), 'application/json');
      msg('已导出 JSON', 'ok');
    };

    // 面板上先显示一下当前页面的周次数量，确认解析正常
    const ws = parseWeeks();
    $('#ct-count').textContent = ws.length ? ws.length + ' 周' : '未识别周次';
    if (!ws.length) msg('未能从页面读取周次列表，可能页面结构有变', 'err');
  }

  // ---------------------------------------------------------------------------

  function boot() {
    if (!document.querySelector('#jxzId')) {
      // 页面可能还在异步渲染
      let n = 0;
      const t = setInterval(() => {
        if (document.querySelector('#jxzId') || ++n > 20) {
          clearInterval(t);
          mount();
        }
      }, 500);
      return;
    }
    mount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
