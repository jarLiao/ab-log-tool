/* UI state contains summaries and one result page. Log bytes stay in the worker. */
(function () {
  'use strict';
  const E = window.ABEngine, $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const num = value => Number(value || 0).toLocaleString('zh-CN');
  const bytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB';
  const shortTime = t => E.timestamp(t).slice(11, 23);
  const colors = {gap: '#a34f05', reorder: '#067d75', duplicate: '#366cb4', collision: '#7743ad',
    parse: '#b13d38', uncertain: '#b13d38', rawOnly: '#a34f05', filteredOnly: '#366cb4', pairOrder: '#067d75', pairUncertain: '#7743ad', matched: '#067d75'};
  let worker, pending = new Map(), requestId = 0, renderId = 0, meta = null;
  let mode = 'raw', inputMode = 'raw', selected = '', currentView = null, activeChart = {}, focused = true;
  let files = {raw: null, filtered: null}, contextText = '', toastTimer, filterTimer, demo = false, started = 0;
  function toast(text, delay = 4200) {
    $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, delay);
  }
  function endWorker() {
    if (worker) worker.terminate();
    worker = null;
    for (const item of pending.values()) item.reject(new Error('已取消'));
    pending.clear();
  }
  function startWorker() {
    endWorker();
    const source = 'self.ABEngine=(' + window.ABEngineFactory.toString() + ')();(' + window.abWorkerMain.toString() + ')();';
    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = ({data: msg}) => {
      if (msg.type === 'progress') {
        $('progress').value = msg.percent; $('progressPercent').textContent = msg.percent + '%'; $('progressText').textContent = msg.text;
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message)); else p.resolve(msg);
    };
    worker.onerror = event => {
      const error = new Error(event.message || '分析线程启动失败，请在新版 Chrome 或 Edge 中重试。');
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    };
  }
  function rpc(type, args = {}) {
    return new Promise((resolve, reject) => {
      if (!worker) { reject(new Error('请先导入日志。')); return; }
      const id = ++requestId; pending.set(id, {resolve, reject});
      worker.postMessage({id, type, ...args});
    });
  }
  function resetWorkspace() {
    meta = null; selected = ''; currentView = null; contextText = ''; renderId++;
    $('workspace').hidden = true; $('welcome').hidden = false; $('exportBtn').disabled = true;
    document.querySelectorAll('[data-mode]').forEach(b => { b.disabled = true; });
    $('rawCount').textContent = $('filteredCount').textContent = '—';
    $('sourceNote').textContent = '导入一份日志独立分析，或导入同一次连接的两份日志进行比较。';
  }
  function setInputMode(m) {
    inputMode = m;
    document.querySelectorAll('[data-input]').forEach(b => { b.classList.toggle('active', b.dataset.input === m); b.setAttribute('aria-pressed', String(b.dataset.input === m)); });
    $('rawDrop').hidden = m === 'filtered'; $('filteredDrop').hidden = m === 'raw';
    $('importDescription').textContent = m === 'pair' ? '选择同一设备、同一次连续连接的原始日志和过滤后日志。' :
      m === 'filtered' ? '选择 abFilter 过滤后日志。缺号可能来自正常过滤。' : '选择 abBle 原始接收日志。每份文件按同一次连续连接分析。';
    $('importError').hidden = true;
  }
  function chooseFile(side, file) {
    files[side] = file || null;
    $(side + 'FileName').textContent = file ? file.name + ' · ' + bytes(file.size) : '尚未选择文件';
    $('importError').hidden = true;
  }
  function openImport() { $('importError').hidden = true; $('importDialog').showModal(); }
  async function analyze(selectedFiles, isDemo = false) {
    demo = isDemo; started = performance.now();
    try {
      for (const file of Object.values(selectedFiles)) {
        if (!file.size) throw new Error(file.name + ' 是空文件，请选择包含报文的日志。');
        if (file.size > 128 * 1048576) throw new Error(file.name + ' 超过 128 MB，请按单次连接范围拆分后分析。');
      }
      if ($('importDialog').open) $('importDialog').close();
      resetWorkspace(); startWorker();
      $('progressTitle').textContent = '正在分析日志'; $('progressText').textContent = '读取文件…';
      $('progress').value = 0; $('progressPercent').textContent = '0%'; $('progressDialog').showModal();
      const response = await rpc('load', {files: selectedFiles});
      meta = response.meta;
      $('progressDialog').close();
      $('welcome').hidden = true; $('workspace').hidden = false; $('exportBtn').disabled = false;
      $('rawCount').textContent = meta.raw ? num(meta.raw.counts.frames) : '—';
      $('filteredCount').textContent = meta.filtered ? num(meta.filtered.counts.frames) : '—';
      document.querySelectorAll('[data-mode]').forEach(b => { b.disabled = !meta[b.dataset.mode]; });
      $('sessionStatus').textContent = (demo ? '演示数据 · ' : '') + ((performance.now() - started) / 1000).toFixed(2) + ' 秒完成';
      $('sourceNote').innerHTML = Object.entries(meta).filter(([key]) => key !== 'pair').map(([key, s]) =>
        '<strong>' + (key === 'raw' ? '原始接收' : '过滤之后') + '</strong>' + esc(s.name) + '<br>' + bytes(s.bytes) + ' · ' + esc(s.encoding) + '<br><br>').join('');
      await changeMode(meta.raw ? 'raw' : 'filtered');
    } catch (e) {
      if (e.message === '已取消') return;
      if ($('progressDialog').open) $('progressDialog').close();
      if (!meta) { resetWorkspace(); endWorker(); }
      $('importError').textContent = '无法完成分析：' + e.message; $('importError').hidden = false;
      if (!$('importDialog').open) $('importDialog').showModal();
    }
  }
  function currentFilter() {
    const t = id => $(id).value ? new Date($(id).value + '+08:00').getTime() : '';
    return {kind: $('kindFilter').value, query: $('search').value.trim(), command: $('commandFilter').value,
      from: t('timeFrom'), to: t('timeTo'), coverage: $('coverageFilter').value};
  }
  function clearFilters() {
    $('search').value = $('commandFilter').value = $('timeFrom').value = $('timeTo').value = '';
    $('kindFilter').value = $('coverageFilter').value = 'all';
  }
  function stats(items) {
    $('stats').innerHTML = items.map(([label, value, sub, kind, tone]) =>
      '<' + (kind ? 'button' : 'div') + ' class="stat ' + (tone || '') + '" data-stat="' + (kind || '') + '" data-count="' + (kind || 'frames') +
      '"><div class="stat-label">' + label + '</div><div class="stat-num">' + num(value) +
      '</div><div class="stat-sub">' + sub + '</div>' + (kind ? '</button>' : '</div>')).join('');
    $('stats').querySelectorAll('[data-stat]').forEach(b => {
      if (b.dataset.stat) b.onclick = () => { clearFilters(); $('kindFilter').value = b.dataset.stat; selected = ''; requestView(); };
    });
  }
  async function changeMode(m) {
    mode = m; selected = ''; focused = true; activeChart = {side: m === 'filtered' ? 'filtered' : 'raw'};
    clearFilters();
    document.querySelectorAll('[data-mode]').forEach(b => { b.classList.toggle('active', b.dataset.mode === m); b.setAttribute('aria-pressed', String(b.dataset.mode === m)); });
    $('viewTitle').textContent = m === 'pair' ? '原始 / 过滤日志配对' : m === 'raw' ? '原始接收日志' : '过滤后的日志';
    $('resultTitle').textContent = m === 'pair' ? '文件差异' : '异常列表';
    $('countHead').textContent = m === 'pair' ? '覆盖范围' : '数量';
    $('chartSide').hidden = m !== 'pair'; $('coverageLabel').hidden = m !== 'pair';
    $('chartSide').value = activeChart.side;
    const kinds = m === 'pair' ? ['rawOnly', 'filteredOnly', 'pairOrder', 'pairUncertain', 'matched'] : ['gap', 'reorder', 'duplicate', 'collision', 'parse', 'uncertain'];
    $('kindFilter').innerHTML = '<option value="all">全部' + (m === 'pair' ? '差异' : '异常') + '</option>' + kinds.map(k => '<option value="' + k + '">' + E.names[k] + '</option>').join('');
    const cmds = m === 'pair' ? [...new Set([...meta.raw.commands, ...meta.filtered.commands])].sort((a, b) => a - b) : meta[m].commands;
    $('commandFilter').innerHTML = '<option value="">全部命令</option>' + cmds.map(n => '<option value="' + n + '">' + E.hexByte(n) + '</option>').join('');
    let notices = [];
    if (m === 'pair') {
      const c = meta.pair.counts;
      $('fileDescription').textContent = meta.raw.name + '  /  ' + meta.filtered.name;
      stats([['匹配报文', c.matched, '逐次匹配', 'matched'], ['仅原始有', c.rawOnly, '未匹配记录', 'rawOnly', 'alert'],
        ['仅过滤有', c.filteredOnly, '未匹配记录', 'filteredOnly'], ['顺序差异', c.pairOrder, '共有帧相对顺序', 'pairOrder'],
        ['配对待核对', c.pairUncertain, '重复对应不唯一', 'pairUncertain', 'special'], ['范围外差异', c.outside, '共有时间范围之外']]);
      $('coverage').textContent = '原始 ' + shortTime(meta.raw.minTime) + '–' + shortTime(meta.raw.maxTime) +
        ' · 过滤 ' + shortTime(meta.filtered.minTime) + '–' + shortTime(meta.filtered.maxTime) + '（北京时间）';
      notices.push('配对只展示两份日志的差异，不自动判断过滤原因。');
      if (!meta.pair.overlap) notices.push('两份文件没有可用的共有时间范围，覆盖范围标为待核对。');
      if (meta.raw.counts.parse + meta.filtered.counts.parse) notices.push('存在解析异常，损坏帧不参与配对。');
    } else {
      const s = meta[m], c = s.counts;
      $('fileDescription').textContent = s.name + ' · ' + bytes(s.bytes) + ' · ' + num(s.lineCount) + ' 行';
      stats([['有效报文', c.frames, num(s.diagnostics) + ' 行诊断文字'], ['最终缺号', c.gap, num(c.gapRanges) + ' 个区间', 'gap', 'alert'],
        ['乱序补到', c.reorder, '已从缺号中移除', 'reorder'], ['重复记录', c.duplicate, '完整帧相同', 'duplicate'],
        ['同号不同内容', c.collision, '单独核对', 'collision', 'special'], ['解析异常', c.parse, '保留原始证据', 'parse', c.parse ? 'alert' : '']]);
      $('coverage').textContent = c.frames ? '覆盖 ' + shortTime(s.minTime) + '–' + shortTime(s.maxTime) + '（北京时间） · ' + s.wraps + ' 次回绕 · ' + s.segments + ' 个可分析段' : '没有可参与序号分析的完整有效报文';
      if (m === 'filtered') notices.push('过滤日志的缺号可能来自正常过滤，请结合原始日志核对。');
      if (c.uncertain) notices.push(c.uncertain + ' 处序号跨度待核对；最终缺号不含跨段未决范围，可在类型筛选中查看。');
      if (c.parse) notices.push(c.parse + ' 条解析 / 校验异常；相关不可信序号未计为有效报文。');
      if (!c.frames) notices.push('未识别到有效报文。请核对日志是否为“毫秒时间戳,十六进制报文”格式，可从解析异常查看原文。');
    }
    $('qualityNote').hidden = !notices.length; $('qualityNote').textContent = notices.join(' ');
    await requestView();
  }
  async function requestView(extra = {}) {
    if (!meta) return;
    const ticket = ++renderId;
    try {
      const view = await rpc('view', {mode, filter: currentFilter(), selected,
        chart: {...activeChart, focus: focused}, ...extra});
      if (ticket !== renderId) return;
      currentView = view; selected = view.selected; activeChart = {side: view.chart.side, lo: view.chart.lo, hi: view.chart.hi};
      $('chartSide').value = view.chart.side;
      renderList(); renderDetail(); renderChart();
    } catch (e) { if (e.message !== '已取消') toast(e.message); }
  }
  function renderList() {
    const v = currentView;
    $('eventRows').innerHTML = v.items.map(e => '<tr tabindex="0" data-id="' + e.id + '" class="' + (e.id === selected ? 'selected' : '') +
      '" aria-selected="' + (e.id === selected) + '"><td><span class="tag ' + e.kind + '">' + E.title(e) +
      '</span></td><td class="mono">' + E.label(e) + '</td><td class="mono">' +
      (mode === 'pair' ? e.coverage === 'inside' ? '共有范围内' : e.coverage === 'outside' ? '共有范围外' : '无共有范围' : e.kind === 'gap' ? num(e.count) : '—') +
      '</td><td class="mono">' + (mode === 'pair' ? e.source === 'raw' ? '原 ' : '滤 ' : '') + 'L' + e.line +
      (e.endLine !== e.line ? '–' + e.endLine : '') + '</td></tr>').join('');
    $('resultCount').textContent = num(v.total) + ' 条';
    $('empty').hidden = v.total > 0;
    $('empty').textContent = '没有符合当前条件的记录。可清除筛选或查看其他类型；统计始终基于完整日志。';
    $('listFooter').textContent = v.total ? '第 ' + num(v.page * v.pageSize + 1) + '–' + num(Math.min(v.total, (v.page + 1) * v.pageSize)) + ' 条' : '0 条记录';
    const pages = Math.max(1, Math.ceil(v.total / v.pageSize));
    $('pageInfo').textContent = (v.page + 1) + ' / ' + pages;
    $('pagePrev').disabled = !v.page; $('pageNext').disabled = v.page + 1 >= pages;
    $('prevBtn').disabled = !v.total || v.selectedIndex === 0;
    $('nextBtn').disabled = !v.total || v.selectedIndex === v.total - 1;
  }
  function renderDetail() {
    const d = currentView.detail; $('copyBtn').disabled = !d;
    if (!d) {
      $('eventID').textContent = '—'; $('detailTitle').textContent = '没有选中的记录'; $('detailSummary').textContent = '从异常列表或图中选择一条记录。';
      $('fields').innerHTML = $('codeSections').innerHTML = ''; $('contextNote').textContent = ''; contextText = ''; return;
    }
    const e = d.event;
    $('eventID').textContent = e.id;
    $('detailTitle').innerHTML = '<span class="tag ' + e.kind + '">' + E.title(e) + '</span> <span class="mono">' + E.label(e) + '</span>';
    $('detailSummary').textContent = d.description;
    const fields = [['源行范围', 'L' + e.line + (e.endLine !== e.line ? '–L' + e.endLine : '')],
      ['接收时间', E.timestamp(e.t)], ['命令 / Key', d.frame ? d.frame.cmd + ' / ' + (d.frame.key || '—') : '不可可靠解析'],
      ['可分析段 / 序号周期', d.frame ? d.frame.segment + ' / ' + d.frame.cycle : '—']];
    $('fields').innerHTML = fields.map(([a, b]) => '<div class="field"><span>' + a + '</span><strong class="mono">' + esc(b) + '</strong></div>').join('');
    $('codeSections').innerHTML = d.sections.map(s => '<div class="code-name">' + s.description + ' · ' + esc(s.name) +
      ' · L' + s.line + (s.endLine !== s.line ? '–L' + s.endLine : '') + '</div><div class="code" tabindex="0" aria-label="' + esc(s.description + ' 原始日志片段') + '">' +
      s.lines.map(l => '<div class="code-line ' + (l.highlight ? 'highlight' : '') + ' ' + (/error|reorder_skip/i.test(l.text) ? 'diagnostic' : '') + '"><span class="ln">' +
        (l.n ?? '…') + '</span><code>' + esc(l.text) + '</code></div>').join('') + '</div>').join('');
    contextText = '[' + e.id + '] ' + E.title(e) + ' ' + E.label(e) + '\n' + d.description + '\n\n' +
      d.sections.map(s => s.name + '\n' + s.lines.map(l => (l.n == null ? '' : 'L' + l.n + '  ') + l.text).join('\n')).join('\n\n');
    $('contextNote').textContent = '原文保留真实行号，默认显示前后各 5 行。' +
      (e.kind === 'gap' ? '缺失序号没有原始报文，上方列出两侧实际存在的记录。' : '重复、同号不同内容及已匹配记录同时列出关联原文。');
    $('codeSections').scrollTop = 0;
  }
  function renderChart() {
    if (!currentView || $('workspace').hidden) return;
    const c = currentView.chart, svg = $('chart'), W = Math.max(300, svg.clientWidth), H = svg.clientHeight || 224;
    const ml = W < 500 ? 48 : 61, mr = 20, mt = 21, mb = 35;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (!c.points.length) { svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5b6b83" font-size="14">没有有效报文可绘制</text>'; return; }
    let min = Infinity, max = -Infinity;
    for (const p of c.points) { min = Math.min(min, p.sid); max = Math.max(max, p.sid); }
    const pad = Math.max(1, (max - min) * .09); min = Math.max(0, min - pad); max = Math.min(65535, max + pad);
    if (max <= min) max = min + 1;
    const x = i => ml + (i - c.lo) / Math.max(1, c.hi - c.lo) * (W - ml - mr);
    const y = value => mt + (max - value) / (max - min) * (H - mt - mb);
    let out = '<title>横轴为接收记录顺序，纵轴为消息序号</title>';
    for (let j = 0; j <= 4; j++) {
      const yy = mt + j * (H - mt - mb) / 4, value = Math.round(max - (max - min) * j / 4);
      out += '<line x1="' + ml + '" y1="' + yy + '" x2="' + (W - mr) + '" y2="' + yy + '" stroke="#e5ebf3" stroke-dasharray="3 4"/><text x="' + (ml - 8) +
        '" y="' + (yy + 4) + '" fill="#5b6b83" text-anchor="end" font-size="12" font-family="Consolas,monospace">' + value + '</text>';
      const i = Math.round(c.lo + (c.hi - c.lo) * j / 4);
      out += '<text x="' + x(i) + '" y="' + (H - 12) + '" text-anchor="middle" font-size="12" fill="#5b6b83">' + num(i + 1) + '</text>';
    }
    let d = '';
    c.points.forEach((p, i) => { const prev = c.points[i - 1]; d += (i && prev.segment === p.segment && prev.cycle === p.cycle ? 'L' : 'M') + x(p.index).toFixed(2) + ' ' + y(p.sid).toFixed(2) + ' '; });
    out += '<path d="' + d + '" stroke="#487bd2" stroke-width="1.8" fill="none" stroke-linejoin="round"/>';
    if (c.hi - c.lo < 80) for (const p of c.points) {
      out += '<circle cx="' + x(p.index) + '" cy="' + y(p.sid) + '" r="3" fill="#fff" stroke="#487bd2"><title>序号 ' + p.sid + ' · L' + p.line + ' · ' + shortTime(p.t) + '</title></circle>';
    }
    for (const wrap of c.wraps) out += '<line x1="' + x(wrap.index) + '" x2="' + x(wrap.index) + '" y1="' + mt + '" y2="' + (H - mb) + '" stroke="#8295ae" stroke-dasharray="4 4"><title>' + wrap.label + ' · 记录 ' + (wrap.index + 1) + '</title></line>';
    const markerTotals = new Map(), markerSlots = new Map();
    for (const m of c.markers) markerTotals.set(m.index, (markerTotals.get(m.index) || 0) + 1);
    for (const m of c.markers) {
      const slot = markerSlots.get(m.index) || 0;
      markerSlots.set(m.index, slot + 1);
      const offset = (slot - (markerTotals.get(m.index) - 1) / 2) * 20;
      const xx = x(m.index), actualY = y(m.sid), yy = Math.max(8, Math.min(H - mb + 9, actualY + offset)), color = colors[m.kind] || '#a34f05';
      const isSelected = m.id === selected, fill = isSelected ? color : '#fff', radius = isSelected ? 6 : 4;
      const title = m.label + (m.count > 1 ? ' · 此位置共 ' + m.count + ' 条，点击放大' : '');
      if (offset) out += '<line x1="' + xx + '" x2="' + xx + '" y1="' + actualY + '" y2="' + yy + '" stroke="' + color + '" stroke-width="1" opacity=".5"/>';
      out += '<g class="chart-marker" data-chart-id="' + m.id + '" role="button" tabindex="0" aria-label="' + esc(title) + '"><title>' + esc(title) + '</title><rect class="hitbox" x="' + (xx - 12) + '" y="' + (yy - 12) + '" width="24" height="24" rx="5" fill="transparent"/>';
      if (m.kind === 'gap') out += '<path d="M' + xx + ' ' + (yy - radius - 1) + 'l' + (radius + 1) + ' ' + (radius * 2) + 'h-' + (radius * 2 + 2) + 'Z" fill="' + fill + '" stroke="' + color + '" stroke-width="1.8"/>';
      else if (m.kind === 'reorder') out += '<path d="M' + xx + ' ' + (yy - radius - 1) + 'l' + (radius + 1) + ' ' + (radius + 1) + 'l-' + (radius + 1) + ' ' + (radius + 1) + 'l-' + (radius + 1) + ' -' + (radius + 1) + 'Z" fill="' + fill + '" stroke="' + color + '" stroke-width="1.8"/>';
      else if (m.kind === 'duplicate') out += '<rect x="' + (xx - radius) + '" y="' + (yy - radius) + '" width="' + (radius * 2) + '" height="' + (radius * 2) + '" fill="' + fill + '" stroke="' + color + '" stroke-width="1.8"/>';
      else if (m.kind === 'collision') out += '<path d="M' + (xx - 5) + ' ' + (yy - 5) + 'l10 10m-10 0 10-10" stroke="' + color + '" stroke-width="' + (isSelected ? 3 : 2) + '"/>';
      else out += '<circle cx="' + xx + '" cy="' + yy + '" r="' + radius + '" fill="' + fill + '" stroke="' + color + '" stroke-width="1.8"/>';
      if (m.count > 1) out += '<text x="' + (xx + 6) + '" y="' + Math.max(12, yy - 9) + '" fill="' + color + '" font-size="11">' + m.count + '</text>';
      out += '</g>';
    }
    svg.innerHTML = out;
    $('chartSubtitle').textContent = '记录 ' + num(c.lo + 1) + '–' + num(c.hi + 1) + ' / ' + num(c.total);
    $('chartHint').textContent = c.markers.some(m => m.count > 1) ? '同位置标记已合并，点击放大' : '点击标记定位原文';
    $('focusBtn').classList.toggle('active', focused); $('fullBtn').classList.toggle('active', !focused && c.lo === 0 && c.hi === c.total - 1);
    const span = c.hi - c.lo;
    $('chartPan').disabled = span >= c.total - 1;
    $('chartPan').value = c.total - 1 - span ? Math.round(c.lo / (c.total - 1 - span) * 1000) : 0;
    $('zoomIn').disabled = span <= 2; $('zoomOut').disabled = span >= c.total - 1;
  }
  function select(id) { selected = id; return requestView(); }
  function zoom(factor) {
    const c = currentView.chart, span = Math.max(2, Math.min(c.total - 1, Math.round((c.hi - c.lo) * factor)));
    const mid = (c.lo + c.hi) / 2, lo = Math.max(0, Math.min(c.total - span - 1, Math.round(mid - span / 2)));
    focused = false; activeChart = {side: c.side, lo, hi: lo + span}; requestView();
  }
  async function exportFile(format) {
    $('csvBtn').disabled = $('txtBtn').disabled = true;
    toast('正在准备导出…', 60000);
    try {
      const result = await rpc('export', {format, mode, filter: currentFilter(), scope: $('exportRange').value});
      const url = URL.createObjectURL(result.blob), a = document.createElement('a');
      a.href = url; a.download = 'AB_' + ($('exportRange').value === 'all' ? '全部结果' : mode + '_筛选结果') + '_' + (format === 'csv' ? '明细.csv' : '原文片段.txt');
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 15000);
      toast('已导出 ' + num(result.count) + ' 条记录');
    } catch (e) { toast('导出失败：' + e.message); }
    finally { $('csvBtn').disabled = $('txtBtn').disabled = false; }
  }
  $('newTask').onclick = $('welcomeImport').onclick = openImport;
  document.querySelectorAll('[data-input]').forEach(b => { b.onclick = () => setInputMode(b.dataset.input); });
  for (const side of ['raw', 'filtered']) {
    const input = $(side + 'File'), zone = $(side + 'Drop');
    input.onchange = () => chooseFile(side, input.files[0]);
    zone.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragging'); };
    zone.ondragleave = () => zone.classList.remove('dragging');
    zone.ondrop = e => { e.preventDefault(); zone.classList.remove('dragging');
      if (e.dataTransfer.files.length !== 1) { $('importError').textContent = '每个区域请选择一份日志。'; $('importError').hidden = false; return; }
      chooseFile(side, e.dataTransfer.files[0]);
    };
  }
  // Prevent a dropped log from navigating away from the analyzer.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
  $('analyzeBtn').onclick = () => {
    const task = {};
    if (inputMode !== 'filtered') task.raw = files.raw;
    if (inputMode !== 'raw') task.filtered = files.filtered;
    if (Object.values(task).some(f => !f)) {
      $('importError').textContent = inputMode === 'pair' ? '请选择原始日志和过滤后日志。' : '请先选择一份日志。';
      $('importError').hidden = false; return;
    }
    analyze(task);
  };
  $('cancelAnalysis').onclick = () => { endWorker(); $('progressDialog').close(); resetWorkspace(); toast('分析已取消，未生成最终结果。'); };
  $('progressDialog').addEventListener('cancel', e => { e.preventDefault(); $('cancelAnalysis').click(); });
  $('demoBtn').onclick = () => {
    const t = 1800000000000, records = [];
    const add = (sid, body, tick) => { records.push((t + (tick ?? records.length) * 8) + ',' + E.makeFrame(sid, body)); };
    add(100); add(102); add(101); add(103);
    records.push(records[3]); add(103, [1, 3, 0x23, 7]); add(105); add(108); add(107); add(109);
    const raw = '\n' + records.map((s, i) => s + (i === 6 ? '\nerror 消息序号中断（演示诊断文字）' : '')).join('\n\n') + '\n';
    const filtered = '\n' + [records[0], records[2], records[1], records[3], records[6], records[9]].join('\n\n') + '\n';
    analyze({raw: new File([raw], '演示_abBle.txt'), filtered: new File([filtered], '演示_abFilter.txt')}, true);
  };
  document.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => changeMode(b.dataset.mode); });
  $('kindFilter').onchange = $('commandFilter').onchange = $('coverageFilter').onchange = $('timeFrom').onchange = $('timeTo').onchange = () => { selected = ''; requestView(); };
  $('search').oninput = () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { selected = ''; requestView(); }, 180); };
  $('resetFilter').onclick = () => { clearFilters(); selected = ''; requestView(); };
  $('moreFilter').onclick = () => { $('extraFilters').hidden = !$('extraFilters').hidden; $('moreFilter').setAttribute('aria-expanded', String(!$('extraFilters').hidden)); };
  $('eventRows').addEventListener('click', e => { const tr = e.target.closest('[data-id]'); if (tr) select(tr.dataset.id); });
  $('eventRows').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { const tr = e.target.closest('[data-id]'); if (tr) { e.preventDefault(); select(tr.dataset.id).then(() => $('eventRows').querySelector('[data-id="' + selected + '"]')?.focus({preventScroll: true})); } }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); requestView({move: e.key === 'ArrowDown' ? 1 : -1}).then(() => $('eventRows').querySelector('[data-id="' + selected + '"]')?.focus({preventScroll: true})); }
  });
  $('chart').addEventListener('click', e => {
    const el = e.target.closest('[data-chart-id]'); if (!el) return;
    const keepFocus = document.activeElement === el;
    const m = currentView.chart.markers.find(m => m.id === el.dataset.chartId);
    if (m.count > 1) { focused = false; activeChart = {side: currentView.chart.side, lo: Math.max(0, m.lo - 3), hi: m.hi + 3}; }
    selected = m.id; requestView().then(() => {
      if (keepFocus) {
        const target = $('chart').querySelector('[data-chart-id="' + selected + '"]') || $('eventRows').querySelector('[data-id="' + selected + '"]');
        target?.focus({preventScroll: true});
      }
    });
  });
  $('chart').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const el = e.target.closest('[data-chart-id]'); if (el) { e.preventDefault(); el.dispatchEvent(new MouseEvent('click', {bubbles: true})); } } });
  $('prevBtn').onclick = () => requestView({move: -1}); $('nextBtn').onclick = () => requestView({move: 1});
  $('pagePrev').onclick = () => requestView({page: currentView.page - 1});
  $('pageNext').onclick = () => requestView({page: currentView.page + 1});
  $('focusBtn').onclick = () => { focused = true; requestView(); };
  $('fullBtn').onclick = () => { focused = false; activeChart = {side: $('chartSide').value}; requestView(); };
  $('chartSide').onchange = () => { focused = false; activeChart = {side: $('chartSide').value}; requestView(); };
  $('zoomIn').onclick = () => zoom(.5); $('zoomOut').onclick = () => zoom(2);
  $('chartPan').oninput = () => {
    const c = currentView.chart, span = c.hi - c.lo, lo = Math.round(Number($('chartPan').value) / 1000 * Math.max(0, c.total - 1 - span));
    focused = false; activeChart = {side: c.side, lo, hi: lo + span}; requestView();
  };
  $('aboutBtn').onclick = () => $('aboutDialog').showModal();
  $('exportBtn').onclick = () => { $('exportScope').textContent = (demo ? '当前为人工生成的演示日志。' : '') + '当前视图筛选出 ' + num(currentView.total) + ' 条记录。'; $('exportDialog').showModal(); };
  document.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => b.closest('dialog').close(); });
  $('csvBtn').onclick = () => exportFile('csv'); $('txtBtn').onclick = () => exportFile('txt');
  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(contextText); toast('已复制关联原始片段。'); }
    catch {
      const area = document.createElement('textarea'); area.value = contextText; document.body.append(area); area.select();
      const ok = document.execCommand('copy'); area.remove(); toast(ok ? '已复制关联原始片段。' : '复制不可用，请在原文区域选择文字复制，或导出 TXT。');
    }
  };
  new ResizeObserver(() => renderChart()).observe($('chart'));
  setInputMode('raw');
})();
