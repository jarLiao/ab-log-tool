/* The worker owns parsed logs; original Files can be archived locally. */
(function () {
  'use strict';
  const E = window.ABEngine, H = window.ABHistory, VERSION = '1.5.1', $ = id => document.getElementById(id);
  const sourceLabel=side=>({raw:'原始接收',filtered:'过滤之后',connection:'连接诊断'}[side]||side);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const num = value => Number(value || 0).toLocaleString('zh-CN');
  const bytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB';
  const shortTime = t => E.timestamp(t).slice(11, 23);
  const useHex = () => $('sequenceBase').value === 'hex';
  function sequenceMarkup(e) {
    const main = useHex() ? E.hexLabel(e) : E.label(e), secondary = useHex() ? 'DEC ' + E.label(e) : 'HEX ' + E.hexLabel(e);
    return '<span class="seq-primary mono">' + main + '</span><span class="seq-secondary mono">' + secondary + '</span>';
  }
  const colors = {gap: '#a34f05', reorder: '#067d75', duplicate: '#366cb4', collision: '#7743ad',
    parse: '#b13d38', uncertain: '#b13d38', rollback: '#b13d38', rawOnly: '#a34f05', filteredOnly: '#366cb4', pairOrder: '#067d75', pairUncertain: '#7743ad', matched: '#067d75'};
  let worker, pending = new Map(), requestId = 0, renderId = 0, meta = null;
  let mode = 'raw', inputMode = 'raw', selected = '', currentView = null, activeChart = {}, focused = true;
  let files = {raw: null, filtered: null,connection:null}, contextText = '', toastTimer, filterTimer, demo = false, started = 0;
  let inspection = null, logStates = [], detailKey = '', chartPoints = [];
  let archive = null, historyEntries = [], historyDelete = null, historyTicket = 0, taskTicket = 0;
  let historyWrite = Promise.resolve();
  const LOG_ROW_HEIGHT = 28;
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
    const source = 'self.ABConnections=('+window.ABConnectionsFactory.toString()+')();self.ABEngine=(' + window.ABEngineFactory.toString() + ')(self.ABConnections);(' + window.abWorkerMain.toString() + ')();';
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
    archive = null; $('historySaveStatus').textContent = ''; $('saveHistoryBtn').hidden = true;
    inspection = null; detailKey = ''; logStates = []; chartPoints = [];
    meta = null; selected = ''; currentView = null; contextText = ''; renderId++;
    $('workspace').hidden = true; $('welcome').hidden = false; $('exportBtn').disabled = true;
    document.querySelectorAll('[data-mode]').forEach(b => { b.disabled = true; });
    $('rawCount').textContent = $('filteredCount').textContent = $('connectionCount').textContent = '—';
    $('sourceNote').textContent = '导入同一设备的日志，可附加连接诊断文件，按连接分段核对。';
  }
  function setInputMode(m) {
    inputMode = m;
    document.querySelectorAll('[data-input]').forEach(b => { b.classList.toggle('active', b.dataset.input === m); b.setAttribute('aria-pressed', String(b.dataset.input === m)); });
    $('rawDrop').hidden = !['raw','pair'].includes(m); $('filteredDrop').hidden = !['filtered','pair'].includes(m);
    $('connectionOptional').textContent=m==='connection'?'（必选）':'（可选）';
    $('importDescription').textContent = m==='connection'?'选择 bleConnection 日志，独立查看连接、断开、重试和错误。没有报文时不判断序号或恢复收包。':m === 'pair' ? '选择同一设备、同一次记录任务的原始日志和过滤后日志；可以包含多次重连。' :
      m === 'filtered' ? '选择 abFilter 过滤后日志。缺号可能来自正常过滤。' : '选择同一设备的 abBle 原始接收日志。无法确认连续性的序号跳变会分段并标记待核对。';
    $('importError').hidden = true;
  }
  function chooseFile(side, file) {
    files[side] = file || null;
    $(side + 'FileName').textContent = file ? file.name + ' · ' + bytes(file.size) : '尚未选择文件';
    $('importError').hidden = true;
  }
  function openImport() { $('importError').hidden = true; $('importDialog').showModal(); }
  async function analyze(selectedFiles, isDemo = false, restored = null) {
    const ticket = ++taskTicket, remember = !isDemo && $('rememberLogs').checked;
    demo = isDemo; started = performance.now();
    try {
      for (const file of Object.values(selectedFiles)) {
        if (!file.size) throw new Error(file.name + ' 是空文件，请选择包含报文的日志。');
        if (file.size > 128 * 1048576) throw new Error(file.name + ' 超过 128 MB，请按完整连接范围拆分后分析。');
      }
      if ($('importDialog').open) $('importDialog').close();
      resetWorkspace(); startWorker();
      $('progressTitle').textContent = '正在分析日志'; $('progressText').textContent = '读取文件…';
      $('progress').value = 0; $('progressPercent').textContent = '0%'; $('progressDialog').showModal();
      const response = await rpc('load', {files: selectedFiles, fingerprint: !isDemo && !restored});
      if (ticket !== taskTicket) return;
      meta = response.meta;
      $('progressDialog').close();
      $('welcome').hidden = true; $('workspace').hidden = false; $('exportBtn').disabled = false;
      $('rawCount').textContent = meta.raw ? num(meta.raw.counts.frames) : '—';
      $('filteredCount').textContent = meta.filtered ? num(meta.filtered.counts.frames) : '—';
      $('connectionCount').textContent=num(meta.connections.counts.events);
      document.querySelectorAll('[data-mode]').forEach(b => { b.disabled = !meta[b.dataset.mode]; });
      $('sessionStatus').textContent = (demo ? '演示数据 · ' : '') + ((performance.now() - started) / 1000).toFixed(2) + ' 秒完成';
      $('sourceNote').innerHTML = Object.entries(meta).filter(([key]) => !['pair','connections'].includes(key)).map(([key, s]) =>
        '<strong>' + sourceLabel(key) + '</strong>' + esc(s.name) + '<br>' + bytes(s.bytes) + ' · ' + esc(s.encoding) + '<br><br>').join('');
      await changeMode(meta.raw ? 'raw' : meta.filtered?'filtered':'connections');
      if (ticket !== taskTicket) return;
      if (isDemo) { $('historySaveStatus').textContent = '演示数据不保存到本机历史。'; return; }
      const sources = Object.entries(selectedFiles).map(([side, file]) => ({side, name: file.name, size: file.size}));
      const id = restored?.id || (sources.every(s => response.fingerprints[s.side]) ? JSON.stringify(sources.map(s => [s.side, s.name, response.fingerprints[s.side]])) :
        'task-' + (crypto.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2)));
      const summary = Object.fromEntries(Object.entries(meta).filter(([side]) => !['pair','connections'].includes(side)).map(([side, s]) => [side, {counts: s.counts, segments: s.segments,connectionCount:s.connectionCount,connectionEvents:s.connectionEvents}]));
      const entry = {id, sources, summary, bytes: sources.reduce((n, s) => n + s.size, 0), version: VERSION, updatedAt: Date.now()};
      archive = {entry, files: {...selectedFiles}, saved: !!restored};
      if (restored) {
        setArchiveStatus('已从本机历史打开，按当前规则重新分析。', false);
        const current = archive;
        historyWrite = historyWrite.catch(() => {}).then(() => H.touch(id, {summary, version: VERSION})).then(found => {
          if (!found && current === archive) { current.saved = false; setArchiveStatus('这条历史已被其他页面删除，当前分析仍可继续。', true); }
          return refreshHistory();
        }).catch(error => { if (current === archive) setArchiveStatus('已打开日志；历史状态更新失败：' + H.errorMessage(error), true); });
      } else if (remember) saveArchive();
      else setArchiveStatus('本次仅查看，尚未保存到本机历史。', true);
    } catch (e) {
      if (e.message === '已取消') return;
      if ($('progressDialog').open) $('progressDialog').close();
      if (!meta) { resetWorkspace(); endWorker(); }
      $('importError').textContent = '无法完成分析：' + e.message; $('importError').hidden = false;
      if (!$('importDialog').open) $('importDialog').showModal();
    }
  }
  function setArchiveStatus(text, canSave) {
    $('historySaveStatus').textContent = text;
    $('saveHistoryBtn').hidden = !canSave; $('saveHistoryBtn').disabled = false;
  }
  function saveArchive() {
    const current = archive;
    if (!current || current.saving) return;
    current.saving = true;
    setArchiveStatus('正在保存完整日志到本机…', false);
    historyWrite = historyWrite.catch(() => {}).then(() => H.save({...current.entry, updatedAt: Date.now()}, current.files)).then(entry => {
      current.entry = entry; current.saved = true;
      if (current === archive) setArchiveStatus('已保存到本机历史，可在下次打开网页时继续查看。', false);
      return refreshHistory();
    }).catch(error => {
      if (current === archive) setArchiveStatus('本次未保存：' + H.errorMessage(error) + ' 当前分析与导出仍可使用。', true);
    }).finally(() => { current.saving = false; });
  }
  function historyMessage(text, error = false) {
    $('historyMessage').textContent = text; $('historyMessage').hidden = !text;
    $('historyMessage').classList.toggle('error-text', error);
  }
  function renderHistory() {
    const query = $('historySearch').value.trim().toLowerCase();
    const entries = historyEntries.filter(entry => entry.sources.some(s => s.name.toLowerCase().includes(query)));
    $('historyList').innerHTML = entries.map(entry => '<article class="history-item"><div class="history-info"><strong>' +
      entry.sources.map(s => esc(s.name)).join('<br>') + '</strong><p>' + (entry.sources.some(s=>s.side==='raw')&&entry.sources.some(s=>s.side==='filtered')?'配对任务 · ':'')+entry.sources.map(s=>sourceLabel(s.side)).join(' + ') +
      ' · ' + bytes(entry.bytes) + ' · 最近打开 ' + esc(E.timestamp(entry.updatedAt).slice(0, 19)) + '</p><p>' +
      entry.sources.map(s => { const summary = entry.summary[s.side]; if(s.side==='connection')return '连接诊断 '+num(summary.connectionEvents)+' 条事件';return sourceLabel(s.side)+' '+ num(summary.counts.frames) +
        ' 帧 · ' + (summary.segments > 1 ? '段内' : '') + '缺号 ' + num(summary.counts.gap); }).join('；') +
      '</p></div><div class="history-item-actions"><button class="button primary" data-history-open="' + esc(entry.id) + '">打开</button>' +
      '<button class="button" data-history-delete="' + esc(entry.id) + '" aria-label="删除历史 ' + esc(entry.sources.map(s => s.name).join(' / ')) + '">删除</button></div></article>').join('');
    $('historyEmpty').hidden = entries.length > 0;
    $('historyEmpty').textContent = historyEntries.length ? '没有匹配的文件名。' : '还没有本机历史。导入日志并完成分析后会自动保存。';
    $('clearHistoryBtn').disabled = !historyEntries.length;
  }
  async function refreshHistory() {
    const ticket = ++historyTicket;
    try {
      const entries = await H.list();
      if (ticket !== historyTicket) return;
      historyEntries = entries; $('historyCount').textContent = num(entries.length);
      $('historyStorage').textContent = entries.length + ' / 20 条 · 日志总大小 ' + bytes(entries.reduce((n, e) => n + e.bytes, 0)) + ' / 512 MB。到达上限时保留旧记录，提示手动清理。';
      renderHistory();
    } catch (error) {
      if (ticket !== historyTicket) return;
      $('historyCount').textContent = '—'; $('historyEmpty').hidden = true;
      historyMessage('无法读取本机历史：' + H.errorMessage(error) + ' 日志分析仍可使用。', true);
    }
  }
  async function openHistory(id) {
    const buttons = $('historyList').querySelectorAll('button'); buttons.forEach(b => { b.disabled = true; });
    historyMessage('正在读取保存的日志…');
    try {
      const saved = await H.get(id), task = {};
      for (const source of saved.entry.sources) {
        const blob = saved.files[source.side];
        if (!(blob instanceof Blob) || blob.size !== source.size) throw new Error('历史日志数据不完整，请重新导入文件。');
        task[source.side] = blob instanceof File ? blob : new File([blob], source.name);
      }
      $('historyDialog').close(); historyMessage('');
      await analyze(task, false, saved.entry);
    } catch (error) { historyMessage(H.errorMessage(error), true); }
    finally { buttons.forEach(b => { b.disabled = false; }); }
  }
  async function deleteHistory() {
    if (!historyDelete) return;
    const target = historyDelete; $('confirmHistoryDelete').disabled = true;
    try {
      await historyWrite;
      if (target === '*') await H.clear(); else await H.remove(target);
      if (archive && (target === '*' || archive.entry.id === target)) {
        archive.saved = false; setArchiveStatus('本机历史已删除；当前页面中的分析可继续使用。', true);
      }
      historyDelete = null; $('historyDeleteConfirm').hidden = true;
      await refreshHistory(); historyMessage(target === '*' ? '已清空本工具的本机历史。' : '已删除这条历史及保存的日志。');
      $('historySearch').focus();
    } catch (error) { historyMessage('删除失败：' + H.errorMessage(error), true); }
    finally { $('confirmHistoryDelete').disabled = false; }
  }
  function currentFilter() {
    const t = id => $(id).value ? new Date($(id).value + '+08:00').getTime() : '';
    return {kind: $('kindFilter').value, query: $('search').value.trim(), command: $('commandFilter').value,
      from: t('timeFrom'), to: t('timeTo'), coverage: $('coverageFilter').value,connection:$('connectionFilter').value};
  }
  function clearFilters() {
    inspection = null;
    $('search').value = $('commandFilter').value = $('timeFrom').value = $('timeTo').value = $('connectionFilter').value = '';
    $('kindFilter').value = $('coverageFilter').value = 'all';
  }
  function stats(items) {
    $('stats').classList.toggle('extended', items.length > 6);
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
    $('workspace').classList.toggle('connection-view',m==='connections');
    clearFilters();
    document.querySelectorAll('[data-mode]').forEach(b => { b.classList.toggle('active', b.dataset.mode === m); b.setAttribute('aria-pressed', String(b.dataset.mode === m)); });
    $('chartPanel').hidden=m==='connections';$('connectionGuide').hidden=m!=='connections';$('pairSessions').hidden=m!=='pair';
    $('commandFilter').hidden=m==='connections';$('segmentSummary').hidden=true;
    $('search').placeholder=m==='connections'?'事件 / 状态码 / 连接编号 / L行号':'0x8404 / 33796 / L行号';
    const groups=m==='connections'?meta.connections.groups:m==='pair'?meta.pair.sessions.map(s=>({key:s.key,label:(s.connectionSource?sourceLabel(s.connectionSource)+' · ':'')+s.connection})):
      [...new Map(meta[m].segmentRanges.map(p=>[p.connectionKey,{key:p.connectionKey,label:p.connection}])).values()];
    $('connectionFilter').innerHTML='<option value="">全部连接</option>'+groups.map(g=>'<option value="'+esc(g.key)+'">'+esc(g.label)+'</option>').join('');
    if(m==='connections'){
      const s=meta.connections,c=s.counts;
      $('viewTitle').textContent='连接时间线';$('resultTitle').textContent='连接事件';$('countHead').textContent='状态码';
      $('fileDescription').textContent='共 '+num(c.events)+' 条事件 · 相同结构化事件保留各处原文 · 单独记录每个连接阶段';
      $('chartSide').hidden=$('coverageLabel').hidden=true;
      $('kindFilter').innerHTML='<option value="all">全部事件</option>'+s.kinds.map(k=>'<option value="'+esc(k)+'">'+esc(E.connectionLabels[k]||k)+'</option>').join('');
      stats([['连接尝试',c.attempts,'开始连接记录','connect_attempt'],['连接就绪',c.ready,'需结合报文确认恢复','connection_ready'],
        ['断开相关记录',c.disconnectEvents,'含不同回调，非断线次数'],['安排重试',c.retries,'查看等待时长','retry_scheduled'],
        ['重试耗尽',c.exhausted,'查看停止位置','retries_exhausted','alert'],['错误 / 失败',c.errors,'状态码仅属于所在事件']]);
      $('qualityNote').hidden=false;$('qualityNote').textContent=[...s.warnings,'日志事件只能说明观察到的状态，不能单凭 Disconnected 或后续错误码确定最初断线原因。'].join(' ');
      $('coverage').textContent='时间为北京时间；时间回退时以同一文件的源行顺序核对。';
      $('recoverySummary').innerHTML=s.recovery.length?s.recovery.map(r=>'<p class="recovery-item"><strong>'+esc(sourceLabel(r.source))+' · L'+r.line+' 断开 → L'+r.readyLine+' 就绪</strong><span>'+(r.ms==null?'间隔未知（时间戳回退）':num(r.ms)+' ms · '+esc(r.clock))+' · '+(r.dataLine?'L'+r.dataLine+' 观察到有效报文':'本文件未观察到后续恢复收包')+'</span></p>').join(''):'<p class="small">尚无可关联的“断开 → 再次就绪”记录。仅导入诊断文件时，无法据此确认是否恢复收包。</p>';
      await requestView();return;
    }
    $('viewTitle').textContent = m === 'pair' ? '原始 / 过滤日志配对' : m === 'raw' ? '原始接收日志' : '过滤后的日志';
    $('resultTitle').textContent = m === 'pair' ? '文件差异' : '异常列表';
    $('countHead').textContent = m === 'pair' ? '覆盖范围' : '数量';
    $('chartSide').hidden = m !== 'pair'; $('coverageLabel').hidden = m !== 'pair';
    $('chartSide').value = activeChart.side;
    const kinds = m === 'pair' ? ['rawOnly', 'filteredOnly', 'pairOrder', 'pairUncertain', 'matched'] : ['gap', 'rollback', 'reorder', 'duplicate', 'collision', 'parse', 'uncertain'];
    $('kindFilter').innerHTML = '<option value="all">全部' + (m === 'pair' ? '差异' : '异常') + '</option>' + kinds.map(k => '<option value="' + k + '">' + E.names[k] + '</option>').join('');
    const cmds = m === 'pair' ? [...new Set([...meta.raw.commands, ...meta.filtered.commands])].sort((a, b) => a - b) : meta[m].commands;
    $('commandFilter').innerHTML = '<option value="">全部命令</option>' + cmds.map(n => '<option value="' + n + '">' + E.hexByte(n) + '</option>').join('');
    let notices = [];
    $('segmentSummary').hidden = true;
    if (m === 'pair') {
      const c = meta.pair.counts;
      $('fileDescription').textContent = meta.raw.name + '  /  ' + meta.filtered.name;
      stats([['匹配报文', c.matched, '逐次匹配', 'matched'], ['仅原始有', c.rawOnly, '未匹配记录', 'rawOnly', 'alert'],
        ['仅过滤有', c.filteredOnly, '未匹配记录', 'filteredOnly'], ['顺序差异', c.pairOrder, '共有帧相对顺序', 'pairOrder'],
        ['配对待核对', c.pairUncertain, '重复对应不唯一', 'pairUncertain', 'special'], ['范围外差异', c.outside, '共有时间范围之外']]);
      $('coverage').textContent = '原始 ' + shortTime(meta.raw.minTime) + '–' + shortTime(meta.raw.maxTime) +
        ' · 过滤 ' + shortTime(meta.filtered.minTime) + '–' + shortTime(meta.filtered.maxTime) + '（北京时间）';
      notices.push('配对只展示两份日志的差异，不自动判断过滤原因。');
      $('pairSessionRows').innerHTML=meta.pair.sessions.map(s=>'<tr><td>'+esc((s.connectionSource?sourceLabel(s.connectionSource)+' · ':'')+s.connection)+'</td><td>'+num(s.matched)+'</td><td>'+num(s.rawOnly)+'</td><td>'+num(s.filteredOnly)+'</td><td>'+num(s.skip)+'</td></tr>').join('');
      if(meta.filtered.associationNote)notices.push(meta.filtered.associationNote);
      if (!meta.pair.overlap) notices.push('两份文件没有可用的共有时间范围，覆盖范围标为待核对。');
      if (meta.raw.counts.parse + meta.filtered.counts.parse) notices.push('存在解析异常，损坏帧不参与配对。');
      if (meta.raw.segments > 1 || meta.filtered.segments > 1) notices.push('序号按连接及待核对边界分段；配对仍按接收时间和完整报文逐次匹配。');
    } else {
      const s = meta[m], c = s.counts;
      $('fileDescription').textContent = s.name + ' · ' + bytes(s.bytes) + ' · ' + num(s.lineCount) + ' 行';
      const gapScope=c.rollback||c.uncertain||s.unassociatedRanges?'段间数量待核对':s.connectionCount>1?'各连接独立统计':num(c.gapRanges)+' 个区间';
      const items = [['有效报文', c.frames, num(s.diagnostics) + ' 行诊断文字'], [s.segments > 1 ? '段内最终缺号' : '最终缺号', c.gap, gapScope, 'gap', 'alert'],
        ['乱序补到', c.reorder, '已从缺号中移除', 'reorder'], ['重复记录', c.duplicate, '完整帧相同', 'duplicate'],
        ['同号不同内容', c.collision, s.segments > 1 ? '各段内部核对' : '单独核对', 'collision', 'special'], ['解析异常', c.parse, '保留原始证据', 'parse', c.parse ? 'alert' : '']];
      if (c.rollback) items.splice(2, 0, ['跳变待核对', c.rollback, '处边界，非丢包数量', 'rollback', 'alert']);
      stats(items);
      $('coverage').textContent = c.frames ? '覆盖 ' + shortTime(s.minTime) + '–' + shortTime(s.maxTime) + '（北京时间） · ' + s.wraps + ' 次回绕 · ' + s.segments + ' 个可分析段' : '没有可参与序号分析的完整有效报文';
      if (m === 'filtered') notices.push('过滤日志的缺号可能来自正常过滤，请结合原始日志核对。');
      if(s.connectionCount>1)notices.push('识别到 '+s.connectionCount+' 个包含报文的连接 / 归属范围，分别统计；跨连接不拼接残帧，也不累计缺号和重复。');
      if(s.associationNote)notices.push(s.associationNote);
      if (c.rollback) notices.push(c.rollback + ' 处序号跳变待核对，暂划分 ' + s.segments + ' 个分析段。跳变处数不是丢包数量；段内缺号为 0 不代表整份日志完整，段间连续性需要核对设备记录。');
      if (c.uncertain) notices.push(c.uncertain + ' 处序号跨度待核对；段内最终缺号不含跨段未决范围，可在类型筛选中查看。');
      if (s.segments > 1) {
        $('segmentSummary').hidden = false;
        $('segmentSummaryTitle').textContent = '查看 ' + s.segments + ' 个分析段的范围与段内缺号';
        $('segmentRows').innerHTML = s.segmentRanges.map(p => '<tr><td>' + p.segment + '<small class="segment-connection">'+esc(p.connection)+'<br>'+esc(p.evidence)+(p.boundaryKind==='rollback'||p.boundaryKind==='uncertain'?' · 序号边界待核对':'')+'</small></td><td class="mono">L' + p.firstLine + '–L' + p.lastLine +
          '</td><td class="mono">' + E.hexWord(p.firstSid) + ' → ' + E.hexWord(p.lastSid) + '</td><td>' + num(p.frames) + '</td><td>' + num(p.gap) + '</td></tr>').join('');
      }
      if (c.parse) notices.push(c.parse + ' 条解析 / 校验异常；相关不可信序号未计为有效报文。');
      if (!c.frames) notices.push('未识别到有效报文。请核对日志是否为“毫秒时间戳,十六进制报文”格式，可从解析异常查看原文。');
    }
    $('qualityNote').hidden = !notices.length; $('qualityNote').textContent = notices.join(' ');
    await requestView();
  }
  async function requestView(extra = {}) {
    if (!meta) return;
    if (extra.move != null || extra.page != null) inspection = null;
    const ticket = ++renderId;
    try {
      const view = await rpc('view', {mode, filter: currentFilter(), selected, inspection,
        chart: {...activeChart, focus: focused}, ...extra});
      if (ticket !== renderId) return;
      currentView = view; selected = view.selected; inspection = view.inspection; activeChart = {side: view.chart.side, lo: view.chart.lo, hi: view.chart.hi};
      $('chartSide').value = view.chart.side;
      renderList(); renderDetail(); renderChart();
    } catch (e) { if (e.message !== '已取消') toast(e.message); }
  }
  function renderList() {
    const v = currentView;
    $('sequenceHead').textContent = mode==='connections'?'事件时间 / 连接':useHex() ? '序号 HEX / DEC' : '序号 DEC / HEX';
    $('eventRows').innerHTML = v.items.map(e => '<tr tabindex="0" data-id="' + e.id + '" class="' + (!inspection && e.id === selected ? 'selected' : '') +
      '" aria-selected="' + (!inspection && e.id === selected) + '"><td>'+(mode==='connections'?'<button class="timeline-select" aria-label="查看 '+esc(E.title(e))+' 原文 L'+e.line+'">':'')+'<span class="tag ' + e.kind + '">' + esc(E.title(e)) +
      '</span>'+(mode==='connections'?'</button>':'')+'</td><td class="sequence-cell">' + (mode==='connections'?'<span class="mono timeline-time"><span>'+esc(E.timestamp(e.t).slice(0,10))+'</span> <span>'+esc(shortTime(e.t))+'</span></span><small class="segment-connection">'+esc(e.connection)+'</small>':sequenceMarkup(e)) + '</td><td class="mono">' +
      (mode==='connections'?e.status==null?'—':e.status:mode === 'pair' ? e.coverage === 'inside' ? '共有范围内' : e.coverage === 'outside' ? '共有范围外' : '无共有范围' : e.kind === 'gap' ? num(e.count) : '—') +
      '</td><td class="mono">' + (mode==='connections'?'<span class="timeline-source">'+esc(sourceLabel(e.source))+'</span> ':mode === 'pair' ? e.source === 'raw' ? '原 ' : '滤 ' : '') + 'L' + e.line +
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
  function rawMarkup(line, anchors, sectionIndex) {
    const ranges = anchors.filter(a => a.line === line.n).sort((a, b) => a.start - b.start);
    let out = '', cursor = 0;
    for (const a of ranges) {
      out += esc(line.text.slice(cursor, a.start)) + '<mark class="seq-byte-mark" tabindex="-1" data-source-byte="' +
        sectionIndex + ':' + a.frameOffset + '" title="序号' + a.role + ' · AB 帧内偏移 ' + a.frameOffset +
        ' · 原文 L' + a.line + ' 第 ' + (a.start + 1) + '–' + a.end + ' 列">' +
        esc(line.text.slice(a.start, a.end)) + '</mark>';
      cursor = a.end;
    }
    return out + esc(line.text.slice(cursor));
  }
  function frameAnchor(frame, index) {
    if (!frame) return '<div class="sequence-anchor no-frame">本行无有效报文 · 序号 — · 命令 / Key — / —</div>';
    const h = frame.header;
    return '<div class="sequence-anchor"><div class="sequence-map"><span>原文字节</span><strong class="mono source-value">' +
      frame.seqBytes + '</strong><span>→</span><strong class="mono">' + frame.sidHex + '</strong><span class="mono">DEC ' + frame.sid +
      '</span><button class="byte-jump" data-locate-byte="' + index + ':6">定位字节</button></div><div class="frame-header">' +
      [['帧头', h[0]], ['属性', h[1]], ['长度', h.slice(2, 4).join(' ')], ['CRC', h.slice(4, 6).join(' ')]].map(([label, value]) =>
        '<span class="header-slot"><small>' + label + '</small><span class="mono">' + value + '</span></span>').join('') +
      '<span class="header-slot sequence-slot"><small>序号 · 低 → 高</small><span class="sequence-byte-buttons">' +
      frame.anchors.map(a => '<button class="mono" data-locate-byte="' + index + ':' + a.frameOffset + '" title="定位序号' + a.role +
        '，原文 L' + a.line + ' 第 ' + (a.start + 1) + ' 列">' + a.value + '</button>').join('') +
      '</span></span><span class="header-slot command-slot"><small>命令</small><strong class="mono">' + (frame.cmd || '—') +
      '</strong></span><span class="header-slot key-slot"><small>Key</small><strong class="mono">' + (frame.key || '—') +
      '</strong></span></div><div class="byte-caption">AB 第 7、8 字节 · 偏移 6、7 · 小端：低字节在前</div><div class="packet-timing">' + esc(E.timingText(frame.timing)) + '</div></div>';
  }
  async function revealByte(target, scrollSection = false) {
    const [section, offset] = target.split(':').map(Number), state = logStates[section];
    const anchor = state?.section.frame?.anchors.find(a => a.frameOffset === offset);
    if (state && anchor && !$('codeSections').querySelector('[data-source-byte="' + target + '"]')) {
      scrollLogTo(state, anchor.line); await loadLogWindow(state, true);
      if (!state.code.isConnected) return;
    }
    const mark = $('codeSections').querySelector('[data-source-byte="' + target + '"]');
    if (!mark) return;
    const code = mark.closest('.code'), box = code.getBoundingClientRect(), at = mark.getBoundingClientRect();
    if (at.left < box.left + 60 || at.right > box.right - 12) code.scrollLeft += at.left - box.left - 85;
    if (at.top < box.top + 5 || at.bottom > box.bottom - 5) code.scrollTop += at.top - box.top - 36;
    if (scrollSection) {
      const parent = $('codeSections');
      const location = mark.getBoundingClientRect(), viewport = parent.getBoundingClientRect();
      if (location.top < viewport.top + 8 || location.bottom > viewport.bottom - 8) parent.scrollTop += location.top - viewport.top - 70;
      mark.focus({preventScroll: true});
    }
  }
  function logUnit(state) {
    const visible = Math.ceil(state.code.clientHeight / LOG_ROW_HEIGHT);
    return state.height < state.section.totalLines * LOG_ROW_HEIGHT ?
      (state.height - state.code.clientHeight) / Math.max(1, state.section.totalLines - visible) : LOG_ROW_HEIGHT;
  }
  function scrollLogTo(state, line) {
    state.code.scrollTop = Math.max(0, line - 5) * Math.max(.001, logUnit(state));
  }
  async function loadLogWindow(state, force = false) {
    if (!state.code.isConnected) return;
    const unit = Math.max(.001, logUnit(state));
    const firstVisible = Math.floor(state.code.scrollTop / unit);
    const first = Math.max(1, firstVisible - 8 + 1);
    if (!force && first === state.first) return;
    const ticket = ++state.ticket; state.first = first;
    state.status.textContent = '正在读取原文…';
    try {
      const result = await rpc('logWindow', {source: state.section.side, first, count: Math.ceil(state.code.clientHeight / LOG_ROW_HEIGHT) + 18});
      if (ticket !== state.ticket || !state.code.isConnected) return;
      const s = state.section, currentLine = state.selectedLine;
      state.window.style.top = (state.code.scrollTop - (state.code.scrollTop / unit - (first - 1)) * LOG_ROW_HEIGHT) + 'px';
      state.window.innerHTML = result.lines.map(l => '<div class="code-line ' + (l.n >= s.line && l.n <= s.endLine ? 'highlight' : '') +
        (l.n === currentLine ? ' selected-line' : '') + (/error|reorder_skip/i.test(l.text) ? ' diagnostic' : '') +
        '" role="option" id="log-line-' + state.index + '-' + l.n + '" aria-posinset="' + l.n + '" aria-setsize="' + result.total +
        '" aria-selected="' + (l.n === currentLine) + '" tabindex="-1" data-log-line="' + l.n + '"><span class="ln">' + l.n +
        '</span><code>' + rawMarkup(l, s.frame?.anchors || [], state.index) + '</code></div>').join('');
      if (result.lines.some(l => l.n === currentLine)) state.code.setAttribute('aria-activedescendant', 'log-line-' + state.index + '-' + currentLine);
      else state.code.removeAttribute('aria-activedescendant');
      state.status.textContent = 'L' + first + '–L' + (first + result.lines.length - 1) + ' / 共 ' + num(result.total) + ' 行 · 点击行查看解析';
    } catch (error) {
      if (ticket === state.ticket && state.code.isConnected && error.message !== '已取消') state.status.textContent = '读取失败：' + error.message;
    }
  }
  async function inspectRecord(selection, position = null, keyboard = false) {
    const ticket = ++renderId;
    try {
      const result = await rpc('inspect', {selection});
      if (ticket !== renderId || !result.detail) return;
      inspection = result.selection; currentView.detail = result.detail;
      renderList(); renderDetail({position}); renderChart();
      const frame = result.detail.frame, chart = currentView.chart;
      if (frame && (chart.side !== inspection.source || frame.index < chart.lo || frame.index > chart.hi)) {
        focused = false; activeChart = {side: inspection.source, lo: Math.max(0, frame.index - 20), hi: frame.index + 20};
        await requestView();
      }
      if (keyboard && logStates[0]) {
        await loadLogWindow(logStates[0], true);
        logStates[0].code.focus({preventScroll: true});
      }
    } catch (error) { if (error.message !== '已取消') toast(error.message); }
  }
  function renderDetail(options = {}) {
    const d = currentView.detail; $('copyBtn').disabled = !d;
    $('recordControls').hidden = !d;
    $('backToEvent').hidden = !inspection || !selected;
    if (!d) {
      detailKey = ''; logStates = [];
      $('recordChoices').hidden = true; $('recordChoices').innerHTML = '';
      $('eventID').textContent = '—'; $('detailTitle').textContent = '没有选中的记录'; $('detailSummary').textContent = '从异常列表或图中选择一条记录。';
      $('fields').innerHTML = $('codeSections').innerHTML = ''; $('contextNote').textContent = ''; contextText = ''; return;
    }
    const e = d.event;
    $('recordPrev').disabled = !d.frame || d.frame.index === 0;
    $('recordNext').disabled = !d.frame || d.frame.index + 1 >= d.frame.total;
    $('recordPosition').textContent = d.frame ? '报文 ' + num(d.frame.index + 1) + ' / ' + num(d.frame.total) : '原文 L' + e.line;
    $('recordChoices').innerHTML = d.choices?.length > 1 ? '<span>本行有 ' + d.choices.length + ' 个有效报文：</span>' + d.choices.map(c =>
      '<button class="button compact" data-record-choice="' + c.index + '" aria-pressed="' + (d.frame?.index === c.index) + '">' +
      E.hexWord(c.sid) + ' · ' + (E.hexByte(c.cmd) || '—') + ' / ' + (E.hexByte(c.key) || '—') + '</button>').join('') : '';
    $('recordChoices').hidden = !d.choices || d.choices.length < 2;
    $('eventID').textContent = e.id;
    $('detailTitle').innerHTML = '<span class="tag ' + e.kind + '">' + esc(E.title(e)) + '</span> <span class="detail-sequence">' + (e.kind==='connection'?esc(e.connection):sequenceMarkup(e)) + '</span>';
    $('detailSummary').textContent = d.description;
    const fields = [['源行范围', 'L' + e.line + (e.endLine !== e.line ? '–L' + e.endLine : '')],
      ['接收时间', E.timestamp(e.t) || '—'], ['命令 / Key', d.frame ? (d.frame.cmd || '—') + ' / ' + (d.frame.key || '—') : '— / —'],
      ['可分析段 / 序号周期', d.frame ? d.frame.segment + ' / ' + d.frame.cycle : '—']];
    if(e.connection||d.frame?.connection)fields.push(['连接会话',e.connection||d.frame.connection],['连接归属依据',d.frame?.connectionEvidence||e.group?.evidence||e.connectionEvidence||'待核对']);
    if(e.kind==='connection'){
      if(e.status!=null)fields.push(['本次事件状态码',e.status+' / 0x'+(e.status>>>0).toString(16).toUpperCase()]);
      if(e.fields?.number)fields.push(['本轮尝试次数',e.fields.number]);
      if(e.fields?.delay_ms)fields.push(['重试等待',e.fields.delay_ms+' ms']);
      if(e.event==='connection_ready')fields.push(['恢复收包证据',e.recovery?.dataLine?'本文件 L'+e.recovery.dataLine:'请核对后续有效报文']);
    }
    if (e.previousSid != null) fields.push(['观测到的数值变化', e.numericChange], ['判定状态', e.directionHint]);
    if (d.frame) fields.push(['与上包间隔', d.frame.timing.label], ['上一有效报文', d.frame.timing.previous ? E.hexWord(d.frame.timing.previous.sid) + ' / L' + d.frame.timing.previous.line : '—（首包）']);
    $('fields').innerHTML = fields.map(([a, b]) => '<div class="field"><span>' + a + '</span><strong class="mono">' + esc(b) + '</strong></div>').join('');
    contextText = '[' + e.id + '] ' + E.title(e) + ' ' + E.dualLabel(e) + '\n' + d.description + '\n连接会话：'+(e.connection||d.frame?.connection||'待核对')+'\n\n' +
      d.sections.map(s => s.name + '\n' + (s.frame ? '原文字节 ' + s.frame.seqBytes + ' → ' + s.frame.sidHex + ' = DEC ' + s.frame.sid + '（小端）\n' : '') +
        (s.frame ? '命令 / Key：' + (s.frame.cmd || '—') + ' / ' + (s.frame.key || '—') + '\n' : '') +
        (s.frame ? E.timingText(s.frame.timing) + '\n' : '') +
        s.lines.map(l => (l.n == null ? '' : 'L' + l.n + '  ') + l.text).join('\n')).join('\n\n');
    $('contextNote').textContent = '可滚动浏览完整文件，点击行同步更新解析；↑ / ↓ 选择相邻行，Home / End 到文件首尾。' +
      (e.kind === 'gap' ? '缺号没有原始报文；黄色字节属于前后实际存在的报文。' : '点击序号低 / 高字节可跳到字段原文。');
    const key = [e.id, e.source, e.line, d.selectedLine].join(':');
    if (key === detailKey && logStates.length && logStates[0].code.isConnected) return;
    detailKey = key;
    $('codeSections').innerHTML = d.sections.map((s, index) => '<section class="raw-section" data-log-section="' + index + '"><div class="code-name">' + s.description + ' · ' + esc(s.name) +
      ' · L' + s.line + (s.endLine !== s.line ? '–L' + s.endLine : '') + '</div>' + frameAnchor(s.frame, index) +
      '<div class="log-toolbar"><label>行号 <input type="number" class="log-jump" min="1" max="' + s.totalLines + '" value="' + (d.selectedLine || s.line) + '" aria-label="跳转原文行号"></label>' +
      '<button data-log-action="jump">跳转</button><button data-log-action="start">首行</button><button data-log-action="end">末行</button><button data-log-action="selected">选中行</button></div>' +
      '<div class="code log-viewport" tabindex="0" role="listbox" aria-label="' + esc(s.name + ' 完整日志，可用上下方向键选择行') + '"><div class="log-canvas"><div class="log-window"></div></div></div>' +
      '<div class="log-status"></div></section>').join('');
    logStates = d.sections.map((s, index) => {
      const el = $('codeSections').querySelector('[data-log-section="' + index + '"]'), code = el.querySelector('.code');
      const height = Math.max(LOG_ROW_HEIGHT, Math.min(8000000, s.totalLines * LOG_ROW_HEIGHT));
      const state = {section: s, index, code, height, window: el.querySelector('.log-window'), status: el.querySelector('.log-status'), ticket: 0,
        selectedLine: d.selectedLine || s.line, first: null};
      const canvas = el.querySelector('.log-canvas'); canvas.style.height = height + 'px';
      canvas.style.minWidth = Math.max(code.clientWidth, (s.maxLineLength + 12) * 7.3) + 'px';
      if (options.position?.source === s.side) { code.scrollTop = options.position.top; code.scrollLeft = options.position.left; }
      else scrollLogTo(state, s.frame?.anchors[0]?.line || s.line);
      code.onscroll = () => { if (!state.scheduled) { state.scheduled = true; requestAnimationFrame(() => { state.scheduled = false; loadLogWindow(state); }); } };
      loadLogWindow(state, true).then(() => { if (!options.position && s.frame) revealByte(index + ':6'); });
      return state;
    });
    $('codeSections').scrollTop = 0;
  }
  function renderChartConnections(c) {
    const groups = c.connectionMarkers || [];
    $('chartConnections').hidden = !groups.length;
    const visible = groups.length > 6 ? [...groups.slice(0, 5), groups.at(-1)] : groups;
    const limitEvents = events => events.length > 8 ? [...events.slice(0, 7), events.at(-1)] : events;
    $('chartConnectionCards').innerHTML = visible.map(group => '<article class="connection-card' + (group.afterLast ? ' is-tail' : '') + '">' +
      '<div class="connection-card-head"><strong>' + esc(group.label) + '</strong><span class="small">' + esc(group.position) + '</span></div>' +
      (group.note ? '<p class="connection-card-note">' + esc(group.note) + '</p>' : '') +
      limitEvents(group.events).map(e => '<button class="connection-entry" data-connection-line="' + e.line + '" aria-label="' +
        esc(e.label + ' · ' + E.timestamp(e.t) + ' · 查看原文 L' + e.line) + '"><span>' + esc(e.label) + '</span><time>' +
        esc(E.timestamp(e.t).slice(0, 23)) + '</time><span class="connection-line">L' + e.line + ' →</span></button>').join('') +
      (group.events.length > 8 ? '<p class="small">另有 ' + (group.events.length - 8) + ' 条记录，请在完整连接时间线查看。</p>' : '') + '</article>').join('');
    $('chartConnectionMore').hidden = groups.length <= visible.length;
    $('chartConnectionMore').textContent = '当前范围有 ' + groups.length + ' 处连接标记，已展示前 5 处和最后 1 处；其余记录可在完整连接时间线查看。';
  }
  function renderChart() {
    if (!currentView || $('workspace').hidden || mode==='connections') return;
    const c = currentView.chart, svg = $('chart'), W = Math.max(300, svg.clientWidth), H = svg.clientHeight || 224;
    renderChartConnections(c);
    const ml = useHex() ? (W < 500 ? 61 : 73) : (W < 500 ? 48 : 61), mr = 20, mt = c.connectionMarkers.length || c.wraps.length > 1 ? 48 : 21, mb = 35;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (!c.points.length) { svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5b6b83" font-size="14">没有有效报文可绘制</text>'; return; }
    let min = Infinity, max = -Infinity;
    for (const p of c.points) { min = Math.min(min, p.sid); max = Math.max(max, p.sid); }
    const pad = Math.max(1, (max - min) * .09); min = Math.max(0, min - pad); max = Math.min(65535, max + pad);
    if (max <= min) max = min + 1;
    const x = i => ml + (i - c.lo) / Math.max(1, c.hi - c.lo) * (W - ml - mr);
    const y = value => mt + (max - value) / (max - min) * (H - mt - mb);
    chartPoints = c.points.map(p => ({...p, x: x(p.index), y: y(p.sid)}));
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-label', '序号变化图，可点击普通报文查看原文，左右方向键选择相邻报文');
    let out = '<title>横轴为接收记录顺序，纵轴为消息序号</title>';
    for (let j = 0; j <= 4; j++) {
      const yy = mt + j * (H - mt - mb) / 4, value = Math.round(max - (max - min) * j / 4);
      out += '<line x1="' + ml + '" y1="' + yy + '" x2="' + (W - mr) + '" y2="' + yy + '" stroke="#e5ebf3" stroke-dasharray="3 4"/><text x="' + (ml - 8) +
        '" y="' + (yy + 4) + '" fill="#5b6b83" text-anchor="end" font-size="12" font-family="Consolas,monospace">' + (useHex() ? E.hexWord(value) : value) + '</text>';
      const i = Math.round(c.lo + (c.hi - c.lo) * j / 4);
      out += '<text x="' + x(i) + '" y="' + (H - 12) + '" text-anchor="middle" font-size="12" fill="#5b6b83">' + num(i + 1) + '</text>';
    }
    let d = '';
    c.points.forEach((p, i) => { const prev = c.points[i - 1]; d += (i && prev.segment === p.segment && prev.cycle === p.cycle ? 'L' : 'M') + x(p.index).toFixed(2) + ' ' + y(p.sid).toFixed(2) + ' '; });
    out += '<path d="' + d + '" stroke="#487bd2" stroke-width="1.8" fill="none" stroke-linejoin="round"/>';
    if (c.hi - c.lo < 80) for (const p of c.points) {
      const isSelected = inspection?.source === c.side && inspection.index === p.index;
      const title = '报文 ' + (p.index + 1) + ' · 序号 ' + E.hexWord(p.sid) + ' / DEC ' + p.sid + ' · 命令 / Key ' +
        (E.hexByte(p.cmd) || '—') + ' / ' + (E.hexByte(p.key) || '—') + ' · L' + p.line + ' · ' + shortTime(p.t) + ' · ' + E.timingText(p.timing);
      out += '<g class="chart-record" data-record-index="' + p.index + '" role="button" tabindex="-1" aria-label="' + esc(title) + '"><title>' + esc(title) +
        '</title><rect x="' + (x(p.index) - 12) + '" y="' + (y(p.sid) - 12) + '" width="24" height="24" fill="transparent"/>' +
        '<circle cx="' + x(p.index) + '" cy="' + y(p.sid) + '" r="' + (isSelected ? 5 : 3) + '" fill="' + (isSelected ? '#285cce' : '#fff') + '" stroke="#487bd2"/></g>';
    }
    const inspectedFrame = inspection?.source === c.side ? currentView.detail?.frame : null;
    if (inspectedFrame && inspectedFrame.index >= c.lo && inspectedFrame.index <= c.hi) {
      out += '<g class="chart-selection" pointer-events="none"><line x1="' + x(inspectedFrame.index) + '" x2="' + x(inspectedFrame.index) +
        '" y1="' + mt + '" y2="' + (H - mb) + '" stroke="#285cce" stroke-dasharray="3 4" opacity=".5"/><circle cx="' + x(inspectedFrame.index) +
        '" cy="' + y(inspectedFrame.sid) + '" r="5" fill="#285cce" stroke="#fff" stroke-width="1.5"/></g>';
    }
    const annotations = c.wraps.map(wrap => ({index: wrap.index, boundary: true, label: wrap.label,
      text: wrap.kind === 'connection' ? '连接区间切换' : wrap.kind === 'attribution' ? '连接归属待核对' : '分段 / 回绕',
      group: c.connectionMarkers.find(g => g.boundary && g.index === wrap.index)}));
    for (const group of c.connectionMarkers) if (!group.boundary) annotations.push({index: group.index, label: group.label, text: group.label, group});
    const labelSpans = [[], []];
    // Reserve the terminal label first so dense internal boundaries cannot hide it.
    for (const a of [...annotations].sort((a, b) => Number(!!b.group?.afterLast) - Number(!!a.group?.afterLast) || a.index - b.index)) {
      const width = a.text.length * 12;
      a.tx = Math.max(width / 2 + 6, Math.min(W - width / 2 - 6, x(a.index)));
      const left = a.tx - width / 2, right = a.tx + width / 2;
      a.lane = labelSpans.findIndex(spans => spans.every(span => right + 8 < span[0] || left > span[1] + 8));
      if (a.lane >= 0) labelSpans[a.lane].push([left, right]);
    }
    for (const a of annotations.sort((a, b) => a.index - b.index)) {
      const xx = x(a.index), color = a.group && !a.boundary ? '#a34f05' : '#067d75';
      const title = a.label + (a.group ? ' · ' + a.group.position + (a.group.note ? ' · ' + a.group.note : '') + '\n' +
        a.group.events.map(e => e.label + ' ' + E.timestamp(e.t) + ' · L' + e.line).join('\n') : ' · 记录 ' + (a.index + 1));
      const attr = a.boundary ? 'class="chart-boundary" data-record-index="' + a.index + '"' :
        'class="chart-connection" data-connection-id="' + a.group.id + '"';
      out += '<g ' + attr + ' role="button" tabindex="0" aria-label="' + esc(title) + '"><title>' + esc(title) + '</title>' +
        '<rect x="' + (xx - 12) + '" y="0" width="24" height="' + (H - mb) + '" fill="transparent"/>' +
        '<line x1="' + xx + '" x2="' + xx + '" y1="' + mt + '" y2="' + (H - mb) + '" stroke="' + color + '" stroke-dasharray="4 4"/>' +
        (!a.boundary ? '<circle cx="' + xx + '" cy="' + mt + '" r="4" fill="' + color + '"/>' : '') +
        (a.lane >= 0 ? '<text x="' + a.tx + '" y="' + (14 + a.lane * 17) + '" text-anchor="middle" fill="' + color + '" font-size="12">' + esc(a.text) + '</text>' : '') + '</g>';
    }
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
    $('chartHint').textContent = c.markers.some(m => m.count > 1) ? '普通报文可点击 · 合并异常点击放大' : '普通报文与异常均可点击 · ← / → 切换报文';
    $('focusBtn').classList.toggle('active', focused); $('fullBtn').classList.toggle('active', !focused && c.lo === 0 && c.hi === c.total - 1);
    $('focusBtn').textContent = inspection ? '选中报文' : '异常附近';
    const span = c.hi - c.lo;
    $('chartPan').disabled = span >= c.total - 1;
    $('chartPan').value = c.total - 1 - span ? Math.round(c.lo / (c.total - 1 - span) * 1000) : 0;
    $('zoomIn').disabled = span <= 2; $('zoomOut').disabled = span >= c.total - 1;
  }
  function select(id) { inspection = null; detailKey = ''; selected = id; return requestView(); }
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
  $('sequenceBase').onchange = () => { if (currentView) { renderList(); renderDetail(); renderChart(); } };
  $('codeSections').addEventListener('click', e => {
    const button = e.target.closest('[data-locate-byte]');
    if (button) { revealByte(button.dataset.locateByte, true); return; }
    const section = e.target.closest('[data-log-section]'), state = section && logStates[Number(section.dataset.logSection)];
    if (!state) return;
    const action = e.target.closest('[data-log-action]')?.dataset.logAction;
    if (action) {
      const n = action === 'start' ? 1 : action === 'end' ? state.section.totalLines : action === 'selected' ? state.selectedLine : Number(section.querySelector('.log-jump').value);
      if (!Number.isInteger(n) || n < 1 || n > state.section.totalLines) { toast('行号范围为 1–' + state.section.totalLines); return; }
      scrollLogTo(state, n); loadLogWindow(state, true); return;
    }
    const line = e.target.closest('[data-log-line]');
    if (line && window.getSelection().isCollapsed) inspectRecord({source: state.section.side, line: Number(line.dataset.logLine)}, {source: state.section.side, top: state.code.scrollTop, left: state.code.scrollLeft});
  });
  $('codeSections').addEventListener('keydown', e => {
    if (e.target.matches('.log-jump') && e.key === 'Enter') { e.preventDefault(); e.target.closest('.raw-section').querySelector('[data-log-action="jump"]').click(); return; }
    const code = e.target.closest('.log-viewport');
    if (!code || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const state = logStates[Number(code.closest('.raw-section').dataset.logSection)];
    const n = e.key === 'Home' ? 1 : e.key === 'End' ? state.section.totalLines : Math.max(1, Math.min(state.section.totalLines, state.selectedLine + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault(); scrollLogTo(state, n);
    inspectRecord({source: state.section.side, line: n}, {source: state.section.side, top: code.scrollTop, left: code.scrollLeft}, true);
  });
  $('recordChoices').onclick = e => { const b = e.target.closest('[data-record-choice]'); if (b) inspectRecord({...inspection, index: Number(b.dataset.recordChoice)}, logStates[0] ? {source: inspection.source, top: logStates[0].code.scrollTop, left: logStates[0].code.scrollLeft} : null); };
  $('recordPrev').onclick = () => inspectRecord({source: currentView.detail.event.source, index: currentView.detail.frame.index - 1});
  $('recordNext').onclick = () => inspectRecord({source: currentView.detail.event.source, index: currentView.detail.frame.index + 1});
  $('backToEvent').onclick = () => select(selected);
  document.querySelectorAll('[data-input]').forEach(b => { b.onclick = () => setInputMode(b.dataset.input); });
  for (const side of ['raw', 'filtered','connection']) {
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
    if (['raw','pair'].includes(inputMode)) task.raw = files.raw;
    if (['filtered','pair'].includes(inputMode)) task.filtered = files.filtered;
    if(inputMode==='connection'||files.connection)task.connection=files.connection;
    if (Object.values(task).some(f => !f)) {
      $('importError').textContent = inputMode === 'pair' ? '请选择原始日志和过滤后日志。' : '请先选择一份日志。';
      $('importError').hidden = false; return;
    }
    analyze(task);
  };
  $('clearConnectionFile').onclick=()=>{chooseFile('connection',null);$('connectionFile').value='';};
  $('cancelAnalysis').onclick = () => { taskTicket++; endWorker(); $('progressDialog').close(); resetWorkspace(); toast('分析已取消，未生成最终结果。'); };
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
  $('kindFilter').onchange = $('commandFilter').onchange = $('connectionFilter').onchange = $('coverageFilter').onchange = $('timeFrom').onchange = $('timeTo').onchange = () => { inspection = null; selected = ''; requestView(); };
  $('search').oninput = () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { inspection = null; selected = ''; requestView(); }, 180); };
  $('resetFilter').onclick = () => { clearFilters(); selected = ''; requestView(); };
  $('moreFilter').onclick = () => { $('extraFilters').hidden = !$('extraFilters').hidden; $('moreFilter').setAttribute('aria-expanded', String(!$('extraFilters').hidden)); };
  $('eventRows').addEventListener('click', e => { const tr = e.target.closest('[data-id]'); if (tr) select(tr.dataset.id); });
  $('eventRows').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { const tr = e.target.closest('[data-id]'); if (tr) { e.preventDefault(); select(tr.dataset.id).then(() => $('eventRows').querySelector('[data-id="' + selected + '"]')?.focus({preventScroll: true})); } }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); requestView({move: e.key === 'ArrowDown' ? 1 : -1}).then(() => $('eventRows').querySelector('[data-id="' + selected + '"]')?.focus({preventScroll: true})); }
  });
  $('chart').addEventListener('click', e => {
    const connection = e.target.closest('[data-connection-id]');
    if (connection) {
      const group = currentView.chart.connectionMarkers.find(g => g.id === connection.dataset.connectionId);
      const keepFocus = document.activeElement === connection;
      inspectRecord({source: currentView.chart.side, line: group.events[0].line}).then(() => {
        if (keepFocus) $('chart').querySelector('[data-connection-id="' + group.id + '"]')?.focus({preventScroll: true});
      });
      return;
    }
    const el = e.target.closest('[data-chart-id]');
    if (!el) {
      let index = e.target.closest('[data-record-index]')?.dataset.recordIndex;
      if (index == null) {
        const svg = $('chart'), point = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
        let best = null, distance = 24 * 24;
        for (const p of chartPoints) { const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2; if (d <= distance) { distance = d; best = p; } }
        index = best?.index;
      }
      if (index != null) inspectRecord({source: currentView.chart.side, index: Number(index)});
      return;
    }
    const keepFocus = document.activeElement === el;
    const m = currentView.chart.markers.find(m => m.id === el.dataset.chartId);
    if (m.count > 1) { focused = false; activeChart = {side: currentView.chart.side, lo: Math.max(0, m.lo - 3), hi: m.hi + 3}; }
    inspection = null; selected = m.id; requestView().then(() => {
      if (keepFocus) {
        const target = $('chart').querySelector('[data-chart-id="' + selected + '"]') || $('eventRows').querySelector('[data-id="' + selected + '"]');
        target?.focus({preventScroll: true});
      }
    });
  });
  $('chart').addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); const c = currentView.chart, index = inspection?.source === c.side && inspection.index != null ? inspection.index : c.lo;
      inspectRecord({source: c.side, index: Math.max(0, Math.min(c.total - 1, index + (e.key === 'ArrowRight' ? 1 : -1)))}).then(() => $('chart').focus({preventScroll: true}));
    } else if (e.key === 'Enter' || e.key === ' ') {
      const el = e.target.closest('[data-chart-id], [data-record-index], [data-connection-id]'); e.preventDefault();
      if (el) el.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      else if (currentView.chart.total) inspectRecord({source: currentView.chart.side, index: currentView.chart.lo});
    }
  });
  $('chartTimeline').onclick = () => changeMode('connections');
  $('chartConnectionCards').onclick = e => {
    const button = e.target.closest('[data-connection-line]');
    if (!button) return;
    const line = Number(button.dataset.connectionLine);
    inspectRecord({source: currentView.chart.side, line}).then(() => {
      $('detailTitle').tabIndex = -1;
      $('detailTitle').focus({preventScroll: true});
      $('detailTitle').scrollIntoView({block: 'start'});
    });
  };
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
  $('historyBtn').onclick = async () => {
    historyMessage(''); historyDelete = null; $('historyDeleteConfirm').hidden = true;
    $('historyDialog').showModal(); $('historySearch').focus();
    await historyWrite; await refreshHistory();
  };
  $('saveHistoryBtn').onclick = saveArchive;
  $('refreshHistoryBtn').onclick = () => { historyMessage(''); refreshHistory(); };
  $('historySearch').oninput = renderHistory;
  $('historyList').onclick = event => {
    const open = event.target.closest('[data-history-open]'), remove = event.target.closest('[data-history-delete]');
    if (open) openHistory(open.dataset.historyOpen);
    if (remove) {
      historyDelete = remove.dataset.historyDelete;
      const entry = historyEntries.find(e => e.id === historyDelete);
      $('historyDeleteText').textContent = '删除 ' + entry.sources.map(s => s.name).join(' / ') + ' 的本机历史和保存的日志？原始文件不受影响。';
      $('historyDeleteConfirm').hidden = false; $('cancelHistoryDelete').focus();
    }
  };
  $('clearHistoryBtn').onclick = () => {
    historyDelete = '*'; $('historyDeleteText').textContent = '清空本工具的全部 ' + historyEntries.length + ' 条本机历史和保存的日志？原始文件不受影响。';
    $('historyDeleteConfirm').hidden = false; $('cancelHistoryDelete').focus();
  };
  $('cancelHistoryDelete').onclick = () => { historyDelete = null; $('historyDeleteConfirm').hidden = true; $('historySearch').focus(); };
  $('confirmHistoryDelete').onclick = deleteHistory;
  try { $('rememberLogs').checked = localStorage.getItem('ab-log-remember') !== 'false'; } catch { /* Session preference still works. */ }
  $('rememberLogs').onchange = () => { try { localStorage.setItem('ab-log-remember', String($('rememberLogs').checked)); } catch {} };
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
  refreshHistory();
})();
