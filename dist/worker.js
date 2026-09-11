/* Embedded as a Blob worker by app.js; also works with file:// previews. */
function abWorkerMain() {
  'use strict';
  const E = self.ABEngine;
  let data = {}, cachedKey = '', cachedEvents = [], lastProgress = 0;
  function sendProgress(percent, text) {
    const now = Date.now();
    if (now - lastProgress > 80 || percent >= 100) {
      self.postMessage({type: 'progress', percent: Math.round(percent), text}); lastProgress = now;
    }
  }
  function getEvents(mode, filter) {
    const key = mode + '|' + JSON.stringify(filter);
    if (key !== cachedKey) { cachedEvents = E.selectEvents(data, mode, filter); cachedKey = key; }
    return cachedEvents;
  }
  function eventById(id) {
    if (!id) return null;
    const index = Number(id.slice(1)) - 1;
    const arr = id[0] === 'R' ? data.raw?.events : id[0] === 'F' ? data.filtered?.events :
      id[0] === 'M' ? data.pair?.matches : data.pair?.events;
    return arr?.[index] || null;
  }
  async function read(file) {
    const buffer = await file.arrayBuffer(), bytes = new Uint8Array(buffer);
    let encoding = 'UTF-8', text;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'UTF-16LE';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'UTF-16BE';
    try { text = new TextDecoder(encoding, {fatal: true}).decode(buffer); }
    catch {
      encoding = 'GB18030';
      text = new TextDecoder('gb18030', {fatal: true}).decode(buffer);
    }
    return {text, encoding};
  }
  self.onmessage = async ({data: msg}) => {
    const {id, type} = msg;
    try {
      if (type === 'load') {
        data = {}; cachedEvents = []; cachedKey = '';
        const sides = Object.keys(msg.files);
        for (let i = 0; i < sides.length; i++) {
          const side = sides[i], file = msg.files[side];
          sendProgress(2 + i * 35, '读取 ' + file.name);
          const input = await read(file);
          const start = performance.now();
          const s = E.parse(input.text, file.name, side, (p, stage) =>
            sendProgress(5 + i * 35 + (stage === '分析序号' ? 23 + p * 9 : p * 23), file.name + ' · ' + stage));
          input.text = '';
          s.bytes = file.size; s.encoding = input.encoding; s.elapsed = performance.now() - start;
          data[side] = s;
        }
        if (data.raw && data.filtered) data.pair = E.compare(data.raw, data.filtered, (p, stage) => sendProgress(78 + p * 20, stage));
        sendProgress(100, '分析完成');
        const meta = {};
        for (const side of sides) {
          meta[side] = E.summary(data[side]);
          meta[side].elapsed = data[side].elapsed;
          meta[side].commands = [...new Set(data[side].rows.map(r => r.cmd).filter(n => n != null))].sort((a, b) => a - b);
        }
        if (data.pair) meta.pair = {counts: data.pair.counts, overlap: data.pair.overlap, minTime: data.pair.minTime, maxTime: data.pair.maxTime};
        self.postMessage({id, type: 'loaded', meta});
      } else if (type === 'view') {
        const events = getEvents(msg.mode, msg.filter);
        let selected = eventById(msg.selected), selectedIndex = selected ? events.indexOf(selected) : -1;
        if (msg.move != null && selectedIndex >= 0) selectedIndex = Math.max(0, Math.min(events.length - 1, selectedIndex + msg.move));
        if (selectedIndex < 0) selectedIndex = 0;
        selected = events[selectedIndex] || null;
        const pageSize = 60;
        let page = msg.page ?? Math.floor(selectedIndex / pageSize);
        page = Math.max(0, Math.min(Math.max(0, Math.ceil(events.length / pageSize) - 1), page));
        if (msg.page != null && (selectedIndex < page * pageSize || selectedIndex >= (page + 1) * pageSize)) {
          selectedIndex = page * pageSize; selected = events[selectedIndex] || null;
        }
        let inspection = msg.inspection ? E.inspect(data, msg.inspection) : null;
        const defaultSide = msg.mode === 'filtered' ? 'filtered' : msg.chart?.side || 'raw';
        if (!selected && !inspection && !events.length && msg.filter?.kind === 'all' && !msg.filter.query && !msg.filter.command && !msg.filter.from && !msg.filter.to && data[defaultSide]?.lines.length) {
          inspection = E.inspect(data, {source: defaultSide, index: 0});
        }
        let chartOptions = msg.chart || {};
        const focus = msg.inspection ? inspection?.detail.event : selected;
        if (chartOptions.focus && focus?.index != null) {
          const side = focus.source;
          chartOptions = {side, lo: Math.max(0, focus.index - 20), hi: focus.index + 20};
        }
        self.postMessage({id, type: 'view', total: events.length, page, pageSize,
          selectedIndex, selected: selected?.id || '',
          items: events.slice(page * pageSize, (page + 1) * pageSize),
          inspection: inspection?.selection || null, detail: inspection?.detail || E.detail(data, selected), chart: E.chart(data, msg.mode, msg.filter, chartOptions)});
      } else if (type === 'inspect') {
        self.postMessage({id, type, ...E.inspect(data, msg.selection)});
      } else if (type === 'logWindow') {
        if (!data[msg.source]?.lines) throw new Error('日志来源不存在。');
        self.postMessage({id, type, ...E.logWindow(data[msg.source], msg.first, msg.count)});
      } else if (type === 'export') {
        const events = msg.scope === 'filtered' ? getEvents(msg.mode, msg.filter) :
          [...(data.raw?.events || []), ...(data.filtered?.events || []), ...(data.pair?.events || [])];
        const scope = msg.scope === 'filtered' ? '当前视图与筛选' : '全部文件异常与配对差异';
        const parts = E.exportParts(data, events, msg.format, scope);
        self.postMessage({id, type: 'export', format: msg.format, count: events.length,
          blob: new Blob(parts, {type: msg.format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8'})});
      } else throw new Error('无法识别的请求。');
    } catch (error) {
      self.postMessage({id, type: 'error', message: error.message || String(error)});
    }
  };
}
