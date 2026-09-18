/* AB framing, sequence analysis, comparison and exports. No network or DOM. */
(function (root) {
  'use strict';
  function createEngine(C) {
    const MOD = 65536, HALF = 32768, LEADING_BACKFILL_LIMIT = 4096;
    const BOUNDARY_MIN_RUN = 4, BOUNDARY_LOOKAHEAD = 8, BOUNDARY_MIN_CONFLICTS = 3;
    // Keep the legacy "rollback" ID for filters; a boundary does not prove direction.
    const names = {
      gap: '最终缺号', reorder: '乱序补到', duplicate: '重复记录',
      collision: '同号不同内容', parse: '解析 / 校验异常', uncertain: '序号跨度待核对', rollback: '序号跳变待核对',
      rawOnly: '仅原始日志有', filteredOnly: '仅过滤日志有',
      pairOrder: '共有帧顺序差异', pairUncertain: '配对待核对', matched: '双方都有', record: '报文记录', logLine: '原始日志行', connection: '连接事件'
    };
    const crcTable = Uint16Array.from({length: 256}, (_, n) => {
      let c = n << 8;
      for (let j = 0; j < 8; j++) c = ((c << 1) ^ (c & 0x8000 ? 0x1021 : 0)) & 0xffff;
      return c;
    });
    function crc16(bytes, start = 0, end = bytes.length) {
      let c = 0;
      for (let i = start; i < end; i++) c = ((c << 8) ^ crcTable[(c >>> 8) ^ bytes[i]]) & 0xffff;
      return c;
    }
    const mod = n => ((n % MOD) + MOD) % MOD;
    const hexByte = n => n == null ? '' : '0x' + n.toString(16).padStart(2, '0').toUpperCase();
    const hexWord = n => n == null ? '' : '0x' + mod(n).toString(16).padStart(4, '0').toUpperCase();
    const sequenceBytes = n => n == null ? '' : hexByte(n & 255).slice(2) + ' ' + hexByte((n >>> 8) & 255).slice(2);
    const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    function makeFrame(sid, body = [0x7b, 3, 0x12, 0], props = 0) {
      const bytes = Uint8Array.from([0xab, props, body.length & 255, body.length >>> 8, 0, 0, sid & 255, sid >>> 8, ...body]);
      const c = crc16(bytes, 8);
      bytes[4] = c & 255; bytes[5] = c >>> 8;
      return toHex(bytes);
    }
    function timestamp(t) {
      if (t == null || !Number.isFinite(t)) return '';
      const d = new Date(t);
      if (!Number.isFinite(d.getTime())) return String(t);
      // Display a fixed timezone so exports match AndroidTool sample timestamps.
      return new Date(t + 8 * 3600000).toISOString().replace('T', ' ').replace('Z', ' +08:00');
    }
    function parse(text, name = '日志.txt', side = 'raw', progress = () => {}) {
      const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
      if (lines.at(-1) === '') lines.pop();
      const result = {name, side, lines, rows: [], events: [], diagnostics: 0, dataLines: 0, wraps: 0, segments: 0, maxLineLength: 0};
      const connections=C.tracker(lines,side);
      result.connectionEvents=[];result.skipRecords=[];result.connectionGroups=connections.groups;
      result.orderedSessions=connections.ordered;
      let buf = new Uint8Array(131088), begin = 0, end = 0, absolute = 0;
      let marks = [], markCursor = 0, noiseStart = -1, noiseEnd = -1, noiseCount = 0;
      const word = p => buf[p] | (buf[p + 1] << 8);
      function locate(pos) {
        while (markCursor + 1 < marks.length && marks[markCursor].end <= pos) markCursor++;
        return marks[markCursor] || {line: 1, t: null};
      }
      function issue(reason, start, finish, extra = {}) {
        const a = locate(start), b = locate(Math.max(start, finish - 1));
        result.events.push({kind: 'parse', source: side, line: a.line, endLine: b.line, t: a.t, reason, ...extra});
      }
      function flushNoise() {
        if (noiseCount) {
          issue('帧头之外的数据：跳过 ' + noiseCount + ' 字节。', noiseStart, noiseEnd);
          noiseCount = 0;
        }
      }
      function consume(size) { begin += size; }
      function findValidAfter(from) {
        for (let p = from; p + 8 <= end; p++) {
          if (buf[p] !== 0xab) continue;
          const n = word(p + 2), finish = p + 8 + n;
          if (finish <= end && crc16(buf, p + 8, finish) === word(p + 4)) return p;
        }
        return -1;
      }
      function drain(final = false) {
        while (begin < end) {
          if (buf[begin] !== 0xab) {
            if (!noiseCount) noiseStart = absolute + begin;
            noiseEnd = absolute + begin + 1; noiseCount++; consume(1); continue;
          }
          flushNoise();
          if (end - begin < 8) {
            if (final) { issue('文件或损坏记录边界处残留不完整帧头。', absolute + begin, absolute + end); begin = end; }
            break;
          }
          const bodyLength = word(begin + 2), size = 8 + bodyLength, finish = begin + size;
          if (finish > end) {
            if (!final) break;
            const next = findValidAfter(begin + 1);
            if (next >= 0) {
              issue('长度不符或残帧：在声明长度结束之前找到 CRC 有效的后续帧，已重新定位。', absolute + begin, absolute + next);
              begin = next; continue;
            }
            issue('末尾残帧 / 长度不符：声明 ' + size + ' 字节，实际仅有 ' + (end - begin) + ' 字节。', absolute + begin, absolute + end);
            begin = end; break;
          }
          if (crc16(buf, begin + 8, finish) !== word(begin + 4)) {
            const next = findValidAfter(begin + 1);
            const stop = next >= 0 ? Math.min(next, finish) : finish;
            issue('CRC16 校验不通过；此帧的序号不参与连续性统计。', absolute + begin, absolute + stop);
            // Resynchronize byte by byte after a corrupt frame; a bad length may overlap the next frame.
            consume(1);
            continue;
          }
          const a = locate(absolute + begin);
          const low = locate(absolute + begin + 6);
          const lowLine = low.line, lowOffset = absolute + begin + 6 - low.start;
          const high = locate(absolute + begin + 7);
          const highLine = high.line, highOffset = absolute + begin + 7 - high.start;
          const b = locate(absolute + finish - 1);
          result.rows.push({index: result.rows.length, line: a.line, endLine: b.line, t: a.t, connectionKey:a.connectionKey,
            sid: word(begin + 6), props: buf[begin + 1], cmd: bodyLength ? buf[begin + 8] : null,
            key: bodyLength >= 3 ? buf[begin + 10] : null, bodyLength,
            seqLowLine: lowLine, seqLowOffset: lowOffset, seqHighLine: highLine, seqHighOffset: highOffset,
            hex: toHex(buf.subarray(begin, finish))});
          begin = finish;
        }
        if (final) flushNoise();
      }
      function append(bytes, line, t) {
        const live = end - begin;
        if (begin && (end + bytes.length > buf.length || begin > 65544)) {
          buf.copyWithin(0, begin, end); absolute += begin; begin = 0; end = live;
          marks = marks.slice(markCursor); markCursor = 0;
        }
        if (end + bytes.length > buf.length) {
          const bigger = new Uint8Array(Math.max(buf.length * 2, end + bytes.length));
          bigger.set(buf.subarray(0, end)); buf = bigger;
        }
        marks.push({start: absolute + end, end: absolute + end + bytes.length, line, t, connectionKey:connections.data().key});
        buf.set(bytes, end); end += bytes.length;
        drain();
      }
      for (let i = 0; i < lines.length; i++) {
        result.maxLineLength = Math.max(result.maxLineLength, lines[i].length);
        const s = lines[i].trim();
        if (s) {
          const diagnostic=C.read(s,i+1,side);
          if(diagnostic){
            result.diagnostics++;
            if(diagnostic.skip)result.skipRecords.push(diagnostic);
            if(diagnostic.kind){
              if(connections.accept(diagnostic))drain(true);
              if(diagnostic.event==='error'&&!diagnostic.structured){
                const code=/Error on connection state change\s*\((-?\d+)\)/.exec(lines[i+1]||'');
                if(code){diagnostic.status=Number(code[1]);diagnostic.endLine=i+2;}
              }
              result.connectionEvents.push(diagnostic);
            }
            if(i%2048===0)progress(i/Math.max(1,lines.length),'识别连接事件');
            continue;
          }
          const match = /^(\d{10,16})\s*[,，]\s*(.*)$/.exec(s);
          if (!match) result.diagnostics++;
          else {
            result.dataLines++;
            const h = match[2].replace(/\s+/g, '');
            if (!h || h.length % 2 || /[^0-9a-f]/i.test(h)) {
              drain(true);
              result.events.push({kind: 'parse', source: side, line: i + 1, endLine: i + 1,
                t: Number(match[1]), reason: '十六进制数据为空、包含非法字符或字节不完整。'});
            } else {
              const bytes = new Uint8Array(h.length / 2);
              for (let j = 0; j < bytes.length; j++) bytes[j] = parseInt(h.slice(j * 2, j * 2 + 2), 16);
              append(bytes, i + 1, Number(match[1]));
            }
          }
        }
        if (i % 2048 === 0) progress(i / Math.max(1, lines.length), '识别报文');
      }
      drain(true);
      C.decorate(result);
      analyzeSequence(result, progress);
      const rows = result.rows;
      let minTime = Infinity, maxTime = -Infinity;
      for (const row of rows) { minTime = Math.min(minTime, row.t); maxTime = Math.max(maxTime, row.t); }
      result.minTime = rows.length ? minTime : null; result.maxTime = rows.length ? maxTime : null;
      finalize(result);
      return result;
    }
    function finalize(result) {
      const rows=result.rows,side=result.side;
      result.counts = {frames: rows.length, gap: 0, gapRanges: 0, reorder: 0, duplicate: 0, collision: 0, parse: 0, uncertain: 0, rollback: 0};
      result.events.sort((a, b) => a.line - b.line || a.endLine - b.endLine || a.kind.localeCompare(b.kind));
      result.events.forEach((e, i) => {
        e.id = (side === 'raw' ? 'R' : side==='filtered'?'F':'D') + String(i + 1).padStart(5, '0');
        if (e.kind === 'gap') { result.counts.gap += e.count; result.counts.gapRanges++; }
        else result.counts[e.kind]++;
        if (e.index == null) {
          // Binary-search source order for parse issues without a trustworthy frame.
          let lo = 0, hi = rows.length;
          while (lo < hi) { const m = (lo + hi) >>> 1; if (rows[m].line < e.line) lo = m + 1; else hi = m; }
          e.index = Math.min(rows.length - 1, lo);
        }
        const row=rows[e.index];
        if(row&&e.kind!=='parse'){e.connectionKey=row.connectionKey;e.connection=row.connection;e.appConnection=row.appConnection;e.connectionEvidence=row.connectionEvidence;}
      });
    }
    function analyzeSequence(s, progress) {
      const rows = s.rows, events = s.events;
      let seen = new Map(), variants = new Map(), low = 0, high = 0, segment = 0, highRow = null, segmentStart = 0;
      s.segmentRanges = [];
      // Look ahead only at a verified consecutive run. Multiple previously occupied
      // IDs with new content are not evidence that missing frames have arrived late.
      const forwardRuns = new Uint32Array(rows.length);
      for (let i = rows.length - 1; i >= 0; i--) forwardRuns[i] = 1 +
        (i + 1 < rows.length && rows[i+1].connectionKey===rows[i].connectionKey && mod(rows[i + 1].sid - rows[i].sid) === 1 ? forwardRuns[i + 1] : 0);
      function boundaryEvidence(i, ext) {
        if (!i || ext >= high || mod(rows[i].sid - rows[i - 1].sid) <= HALF || forwardRuns[i] < BOUNDARY_MIN_RUN) return null;
        let conflicts = 0;
        for (let j = 0; j < Math.min(forwardRuns[i], BOUNDARY_LOOKAHEAD); j++) {
          const previousIndex = seen.get(ext + j), candidate = rows[i + j];
          if (previousIndex != null && rows[previousIndex].hex !== candidate.hex && !variants.get(ext + j)?.has(candidate.hex)) conflicts++;
        }
        const beyondStart = ext < low && high - ext > LEADING_BACKFILL_LIMIT;
        return beyondStart || conflicts >= BOUNDARY_MIN_CONFLICTS ? {runLength: forwardRuns[i], conflicts} : null;
      }
      const event = (kind, r, extra = {}) => ({kind, source: s.side, index: r.index, line: r.line, endLine: r.endLine,
        t: r.t, sid: r.sid, cmd: r.cmd, key: r.key, cycle: r.cycle, segment: r.segment, ...extra});
      function finishSegment(endIndex = rows.length - 1) {
        let missing = 0, gapRanges = 0;
        const ordered = [...seen.entries()].sort((a, b) => a[0] - b[0]);
        if (ordered.length) s.wraps += Math.floor(ordered.at(-1)[0] / MOD) - Math.floor(ordered[0][0] / MOD);
        for (let i = 1; i < ordered.length; i++) {
          const [a, prevIndex] = ordered[i - 1], [b, index] = ordered[i];
          if (b <= a + 1) continue;
          // Keep a missing range within one counter cycle for unambiguous display and search.
          let from = a + 1;
          while (from < b) {
            const to = Math.min(b - 1, (Math.floor(from / MOD) + 1) * MOD - 1);
            const r = rows[index], p = rows[prevIndex];
            events.push(event('gap', r, {from: mod(from), to: mod(to), count: to - from + 1,
              cycle: Math.floor(from / MOD), relatedIndex: p.index, relatedSource: s.side,
              relatedLine: p.line, relatedEndLine: p.endLine,
              reason: '本段完整日志中未出现这些序号；关联序号范围两侧的实际报文。'}));
            missing += to - from + 1; gapRanges++;
            from = to + 1;
          }
        }
        if (ordered.length) s.segmentRanges.push({segment, firstIndex: segmentStart, lastIndex: endIndex,
          firstLine: rows[segmentStart].line, lastLine: rows[endIndex].endLine,
          firstSid: rows[segmentStart].sid, lastSid: rows[endIndex].sid,
          frames: endIndex - segmentStart + 1, gap: missing, gapRanges,
          connectionKey:rows[segmentStart].connectionKey,connection:rows[segmentStart].connection,
          evidence:rows[segmentStart].connectionEvidence,boundaryKind:rows[segmentStart].boundaryKind});
      }
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (i === 0) { low = high = r.sid; highRow = r; segment++; }
        const connectionBoundary=i>0&&r.connectionKey!==rows[i-1].connectionKey;
        if(connectionBoundary){
          finishSegment(i-1);seen=new Map();variants=new Map();low=high=r.sid;highRow=r;segment++;segmentStart=i;
          r.boundaryKind=r.connectionEvidence==='未关联'||rows[i-1].connectionEvidence==='未关联'?'attribution':'connection';
        }
        let ext = Math.floor(high / MOD) * MOD + r.sid;
        if (ext - high > HALF) ext -= MOD;
        else if (high - ext > HALF) ext += MOD;
        // Short late arrivals can precede the first logged frame. Expand the observed span
        // so a frame already present at the beginning never becomes a spurious final gap.
        // A large backwards extension has no prior-cycle anchor; leave that span unresolved.
        const boundary = !connectionBoundary&&boundaryEvidence(i, ext);
        const ambiguous = !connectionBoundary&&i && (Math.abs(ext - high) === HALF || ext < low - LEADING_BACKFILL_LIMIT);
        if (boundary || ambiguous) {
          finishSegment(i - 1);
          const p = rows[i - 1], kind = boundary ? 'rollback' : 'uncertain';
          const numericDelta = r.sid - p.sid, forwardDistance = mod(numericDelta), backwardDistance = mod(-numericDelta);
          const numericChange = numericDelta > 0 ? '数值增大 ' + numericDelta : numericDelta < 0 ? '数值减小 ' + (-numericDelta) : '数值相同';
          const directionHint = numericDelta > 0 || Math.abs(numericDelta) === HALF ? '方向待核对' : '原因待核对';
          seen = new Map(); variants = new Map(); low = high = ext = r.sid; highRow = r; segment++;
          segmentStart = i;
          r.segment = segment; r.cycle = 0; r.boundaryKind = kind;
          events.push(event(kind, r, {relatedIndex: p.index, relatedSource: s.side,
            relatedLine: p.line, relatedEndLine: p.endLine, previousSid: p.sid,
            numericDelta, numericChange, forwardDistance, backwardDistance, directionHint, runLength: boundary?.runLength,
            reason: '序号从 ' + hexWord(p.sid) + '（DEC ' + p.sid + '）变为 ' + hexWord(r.sid) +
              '（DEC ' + r.sid + '），' + numericChange + '。' + (directionHint === '方向待核对' ?
                '按 16 位循环序号，候选解释为向前跨越 ' + forwardDistance + ' 或向后跨越 ' + backwardDistance + '；仅凭序号不能确认方向，不能把较短距离当作实际回退。' :
                '这描述的是前后记录的数值变化，不能据此确认设备重启、重置或数据重放。') +
              (boundary ? '从此处起有 ' + boundary.runLength + ' 条连续递增记录。' : '周期归属尚不确定。') +
              '暂划分第 ' + segment + ' 段；只统计各段内部，段间待核对，跨段缺失数量未知。'}));
        }
        r.ext = ext; r.segment = segment; r.cycle = Math.floor(ext / MOD);
        low = Math.min(low, ext);
        const previous = rows[i - 1];
        if (previous && previous.segment === segment && r.cycle > previous.cycle) r.wrap = true;
        if (seen.has(ext)) {
          const first = rows[seen.get(ext)];
          let versions = variants.get(ext);
          if (!versions) { versions = new Map([[first.hex, first.index]]); variants.set(ext, versions); }
          const sameIndex = versions.get(r.hex);
          const related = rows[sameIndex == null ? first.index : sameIndex];
          events.push(event(sameIndex == null ? 'collision' : 'duplicate', r, {
            relatedIndex: related.index, relatedSource: s.side, relatedLine: related.line, relatedEndLine: related.endLine,
            reason: sameIndex == null ? '同一周期序号相同，完整帧内容不同。' : '同一周期序号与完整帧内容均相同；这是一次额外记录。'}));
          if (sameIndex == null) versions.set(r.hex, r.index);
        } else {
          seen.set(ext, i);
          if (i && ext < high) {
            events.push(event('reorder', r, {relatedIndex: highRow.index, relatedSource: s.side,
              relatedLine: highRow.line, relatedEndLine: highRow.endLine,
              reason: '已收到更大序号后才补到此帧；该序号不再计入最终缺号。'}));
          }
        }
        if (ext > high) {
          if (Math.floor(ext / MOD) > Math.floor(high / MOD)) r.wrap = true;
          high = ext; highRow = r;
        }
        if (i % 4096 === 0) progress(i / Math.max(1, rows.length), '分析序号');
      }
      if (rows.length) finishSegment();
      s.segments = segment;
    }
    function compare(raw, filtered, progress = () => {}) {
      associateFiltered(raw,filtered);
      const buckets = new Map(), counts = new Map(), events = [], matches = [];
      const rRows = raw.rows, fRows = filtered.rows;
      const key = r => r.t + '|' + r.hex;
      fRows.forEach((r, i) => {
        const k = key(r);
        let bucket = buckets.get(k);
        if (!bucket) { bucket = {items: [], used: 0}; buckets.set(k, bucket); }
        bucket.items.push(i);
      });
      for (const r of rRows) { const k = key(r); counts.set(k, (counts.get(k) || 0) + 1); }
      const lo = raw.minTime == null || filtered.minTime == null ? null : Math.max(raw.minTime, filtered.minTime);
      const hi = lo == null ? null : Math.min(raw.maxTime, filtered.maxTime);
      const overlap = lo != null && lo <= hi;
      const coverage = r => !overlap ? 'unknown' : r.t < lo || r.t > hi ? 'outside' : 'inside';
      function make(kind, side, r, extra = {}) {
        return {kind, source: side, index: r.index, line: r.line, endLine: r.endLine, t: r.t,
          sid: r.sid, cmd: r.cmd, key: r.key, cycle: r.cycle, segment: r.segment,
          connectionKey:r.connectionKey,connection:r.connection,appConnection:r.appConnection,connectionEvidence:r.connectionEvidence,
          coverage: coverage(r), ...extra};
      }
      const used = new Uint8Array(fRows.length), ambiguousKeys = new Set();
      let highestFiltered = -1, previous = null;
      for (let i = 0; i < rRows.length; i++) {
        const r = rRows[i], k = key(r), bucket = buckets.get(k);
        if(i&&r.connectionKey!==rRows[i-1].connectionKey){highestFiltered=-1;previous=null;}
        if (!bucket || bucket.used >= bucket.items.length) {
          events.push(make('rawOnly', 'raw', r, {reason: '过滤日志中没有剩余的同时间戳、同完整帧记录可配对。不推测原因。'}));
        } else {
          const j = bucket.items[bucket.used++], f = fRows[j]; used[j] = 1;
          const ambiguous = bucket.items.length > 1 || counts.get(k) > 1;
          const common = {relatedSource: 'filtered', relatedIndex: j, relatedLine: f.line, relatedEndLine: f.endLine};
          matches.push(make('matched', 'raw', r, {...common, reason: ambiguous ? '同时间戳且同完整帧，多次出现按记录次序逐个配对；具体对应关系待核对。' : '两侧时间戳和完整帧均相同。'}));
          if (ambiguous && !ambiguousKeys.has(k)) {
            ambiguousKeys.add(k);
            events.push(make('pairUncertain', 'raw', r, {...common,
              reason: '同时间戳且同完整帧重复出现：原始 ' + counts.get(k) + ' 次，过滤 ' + bucket.items.length + ' 次。数量差异确定，逐条对应关系无法唯一确定，不据此判定共有帧乱序。'}));
          }
          if (!ambiguous) {
            if (j < highestFiltered) {
              events.push(make('pairOrder', 'raw', r, {...common,
                anchorSource: 'raw', anchorIndex: previous.index,
                reason: '共有帧在两份文件中的相对顺序不同。原始日志前一参照帧位于 L' + previous.line + '。'}));
            } else { highestFiltered = j; previous = r; }
          }
        }
        if (i % 4096 === 0) progress(i / Math.max(1, rRows.length), '比较两份日志');
      }
      fRows.forEach((r, i) => { if (!used[i]) events.push(make('filteredOnly', 'filtered', r,
        {reason: '原始日志中没有剩余的同时间戳、同完整帧记录可配对。不推测原因。'})); });
      events.forEach((e, i) => { e.id = 'P' + String(i + 1).padStart(5, '0'); });
      matches.forEach((e, i) => { e.id = 'M' + String(i + 1).padStart(5, '0'); });
      const stats = {matched: matches.length, rawOnly: 0, filteredOnly: 0, pairOrder: 0, pairUncertain: 0, inside: 0, outside: 0, unknown: 0};
      for (const e of events) {
        stats[e.kind]++;
        if (e.kind === 'rawOnly' || e.kind === 'filteredOnly') stats[e.coverage]++;
      }
      const skips=new Map(),skipTargets=new Map();
      for(const r of rRows){const k=r.t+'|'+r.sid;skipTargets.set(k,(skipTargets.get(k)||0)+1);}
      for(const e of raw.skipRecords){const k=e.t+'|'+e.to;const list=skips.get(k)||[];list.push(e);skips.set(k,list);}
      for(const e of events)if(e.kind==='rawOnly'){
        const candidates=skips.get(e.t+'|'+e.sid)||[];
        if(candidates.length===1&&candidates[0].reason==='backward_dup'&&skipTargets.get(e.t+'|'+e.sid)===1){
          e.skipLine=candidates[0].line;e.skipReason=candidates[0].reason;
          e.reason+=' 原始日志 L'+e.skipLine+' 记录相同接收时间戳和序号的 reorder_skip（backward_dup）；这是过滤决策记录，不代表蓝牙丢包。';
        }
      }
      const sessions=new Map();
      for(const e of [...matches,...events.filter(e=>['rawOnly','filteredOnly'].includes(e.kind))]){
        const k=e.connectionEvidence==='未关联'?'unknown':e.connectionKey||'unknown';let row=sessions.get(k);
        if(!row){row={key:k,connection:e.connection||'连接归属待核对',connectionSource:k==='unknown'?'':k.split(':')[0],matched:0,rawOnly:0,filteredOnly:0,skip:0};sessions.set(k,row);}
        row[e.kind]++;if(e.skipLine)row.skip++;
      }
      return {events, matches, sessions:[...sessions.values()], counts: stats, overlap, minTime: overlap ? lo : null, maxTime: overlap ? hi : null};
    }
    function associateFiltered(raw,filtered){
      if(filtered.connectionEvents.some(e=>e.ordered||['disconnected','link_loss','process_start'].includes(e.event))||raw.connectionCount<2)return;
      const anchors=new Map(),occurrences=new Map();
      for(const r of raw.rows){const k=r.t+'|'+r.hex;anchors.set(k,anchors.has(k)?null:r);}
      for(const r of filtered.rows){const k=r.t+'|'+r.hex;occurrences.set(k,(occurrences.get(k)||0)+1);}
      let unknown=0,run=0,previous='';
      filtered.connectionGroups=raw.connectionGroups.map(g=>({...g,evidence:'同时间戳与完整帧的唯一配对锚点'}));
      for(const r of filtered.rows){
        const k=r.t+'|'+r.hex,a=occurrences.get(k)===1?anchors.get(k):null;
        if(a)r.connectionKey=a.connectionKey;
        else {if(previous!=='unknown')run++;r.connectionKey='filtered:unknown'+run;unknown++;}
        previous=a?'known':'unknown';
        delete r.wrap;delete r.boundaryKind;
      }
      filtered.associationNote='按唯一的接收时间戳与完整帧关联原始日志会话。'+(unknown?'有 '+unknown+' 条报文无法唯一关联，单独统计；跨归属边界不补缺号。':'');
      C.decorate(filtered);filtered.events=filtered.events.filter(e=>e.kind==='parse');filtered.wraps=0;
      analyzeSequence(filtered,()=>{});finalize(filtered);
    }
    function summary(s) {
      return {name: s.name, side: s.side, bytes: s.bytes, encoding: s.encoding, counts: s.counts,
        lineCount: s.lines.length, maxLineLength: s.maxLineLength, diagnostics: s.diagnostics, dataLines: s.dataLines,
        minTime: s.minTime, maxTime: s.maxTime, firstSid: s.rows[0]?.sid ?? null, lastSid: s.rows.at(-1)?.sid ?? null,
        wraps: s.wraps, segments: s.segments, segmentRanges: s.segmentRanges,connectionCount:s.connectionCount,
        connectionEvents:s.connectionEvents.length,associationNote:s.associationNote,unassociatedRanges:s.unassociatedRanges};
    }
    function title(e) { return e.kind==='connection'?(C.labels[e.event]||e.event):names[e.kind] || e.kind; }
    function label(e) { return e.previousSid != null ? e.previousSid + ' → ' + e.sid : e.kind === 'gap' ? e.from === e.to ? String(e.from) : e.from + '–' + e.to : e.sid == null ? '—' : String(e.sid); }
    function hexLabel(e) { return e.previousSid != null ? hexWord(e.previousSid) + ' → ' + hexWord(e.sid) : e.kind === 'gap' ? e.from === e.to ? hexWord(e.from) : hexWord(e.from) + '–' + hexWord(e.to) : hexWord(e.sid) || '—'; }
    function dualLabel(e) { return hexLabel(e) + '（DEC ' + label(e) + '）'; }
    function descriptions(e, data) {
      let text = e.reason || '';
      if (e.kind === 'gap' && e.source === 'filtered') text += ' 过滤日志的缺号可能来自正常过滤。';
      if (e.coverage) text += e.coverage === 'outside' ? ' 此记录位于双方共有时间范围之外。' : e.coverage === 'unknown' ? ' 两份日志没有可用的共有时间范围。' : ' 此记录位于双方共有时间范围之内。';
      return text;
    }
    function selectEvents(data, mode, filter = {}) {
      const all = mode === 'pair' ? filter.kind === 'matched' ? data.pair.matches : data.pair.events : data[mode]?.events||[];
      if (!filter.query && (!filter.kind || filter.kind === 'all' || filter.kind === 'matched') &&
          !filter.command && !filter.from && !filter.to && !filter.connection && (!filter.coverage || filter.coverage === 'all')) return all;
      const q = (filter.query || '').toLowerCase().trim();
      const numeric = /^(?:0x[\da-f]+|\d+)$/i.test(q) ? Number(q) : null;
      const cmd = filter.command === '' || filter.command == null ? null : Number(filter.command);
      return all.filter(e => {
        if (filter.kind && !['all', 'matched'].includes(filter.kind) && e.kind !== filter.kind && e.event!==filter.kind) return false;
        if(filter.connection&&(filter.connection==='unknown'?e.connectionEvidence!=='未关联':e.connectionKey!==filter.connection))return false;
        if (cmd != null && e.cmd !== cmd) return false;
        if (filter.from && (e.t == null || e.t < Number(filter.from))) return false;
        if (filter.to && (e.t == null || e.t > Number(filter.to))) return false;
        if (filter.coverage && filter.coverage !== 'all' && e.coverage !== filter.coverage) return false;
        return !q || (numeric != null && (e.sid === numeric || e.previousSid === numeric || e.kind === 'gap' && numeric >= e.from && numeric <= e.to)) ||
          [e.id, title(e), label(e),e.connection,e.appConnection,e.event,e.status,e.reason,'L' + e.line, 'L' + e.endLine, timestamp(e.t), hexByte(e.cmd), hexByte(e.key), data[e.source].name]
            .some(v => String(v).toLowerCase().includes(q));
      });
    }
    function sequenceSource(s, row) {
      if (!row) return [];
      return [[row.seqLowLine, row.seqLowOffset, 6], [row.seqHighLine, row.seqHighOffset, 7]].map(([line, offset, frameOffset]) => {
        const text = s.lines[line - 1];
        const prefix = /^\s*\d{10,16}\s*[,，]\s*/.exec(text);
        if (!prefix) throw new Error('无法定位序号原始字节。');
        let nibble = 0, start = -1, end = -1;
        for (let i = prefix[0].length; i < text.length; i++) {
          if (/\s/.test(text[i])) continue;
          if (nibble === offset * 2) start = i;
          if (nibble === offset * 2 + 1) { end = i + 1; break; }
          nibble++;
        }
        if (start < 0 || end < 0) throw new Error('序号原文位置超出记录范围。');
        return {line, start, end, frameOffset, role: frameOffset === 6 ? '低字节' : '高字节',
          value: row.hex.slice(frameOffset * 2, frameOffset * 2 + 2).toUpperCase()};
      });
    }
    function packetTiming(s, row) {
      if (!row) return null;
      const previous = s.rows[row.index - 1];
      if (!previous) return {ms: null, previous: null, label: '—（首包）', hint: '本日志的第一条有效报文，没有上包。'};
      const ms = Number.isSafeInteger(row.t) && Number.isSafeInteger(previous.t) ? row.t - previous.t : null;
      const acrossSegment = previous.segment !== row.segment;
      const acrossConnection=previous.connectionKey!==row.connectionKey;
      return {ms, previous: {index: previous.index, line: previous.line, endLine: previous.endLine, sid: previous.sid, t: previous.t}, acrossSegment,acrossConnection,
        label: ms == null ? '—（时间戳不可用）' : ms + ' ms' + (Math.abs(ms) >= 1000 ? '（' + (ms / 1000).toFixed(3) + ' s）' : ''),
        hint: (ms == null ? '无法可靠计算时间差。' : ms < 0 ? '时间戳回退，保留原始负值。' : ms === 0 ? '两包使用相同的接收时间戳。' : '当前接收时间减去上一有效报文的接收时间。') +
          (acrossConnection?'跨连接 / 归属边界，仅表示日志接收时间差，不计为同一连接收包停顿。':acrossSegment ? '跨分析段，仅表示日志接收时间差。' : '')};
    }
    function timingText(timing) {
      return timing ? '与上包间隔：' + timing.label + (timing.previous ? '；上包 ' + hexWord(timing.previous.sid) + ' / L' + timing.previous.line : '') + '。' + timing.hint : '';
    }
    function frameInfo(s, row) {
      if (!row) return null;
      return {index: row.index, line: row.line, endLine: row.endLine, total: s.rows.length, sid: row.sid, sidHex: hexWord(row.sid), seqBytes: sequenceBytes(row.sid),
        cmd: hexByte(row.cmd), key: hexByte(row.key), cycle: row.cycle, segment: row.segment, timing: packetTiming(s, row),
        connection:row.connection,connectionKey:row.connectionKey,appConnection:row.appConnection,connectionEvidence:row.connectionEvidence,
        length: row.bodyLength + 8, t: timestamp(row.t), hex: row.hex.slice(0, 512), truncated: row.hex.length > 512,
        header: row.hex.slice(0, 16).toUpperCase().match(/../g), anchors: sequenceSource(s, row)};
    }
    function context(s, start, end, radius = 5, anchorLines = []) {
      const lo = Math.max(1, start - radius), hi = Math.min(s.lines.length, end + radius);
      // A single fragmented frame can span thousands of source lines; show both ends and disclose the omitted middle.
      const candidates = hi - lo > 100 ? [[lo, lo + 39], [hi - 39, hi],
        ...anchorLines.map(n => [Math.max(lo, n - 2), Math.min(hi, n + 2)])] : [[lo, hi]];
      candidates.sort((a, b) => a[0] - b[0]);
      const spans = [];
      for (const range of candidates) {
        if (spans.length && range[0] <= spans.at(-1)[1] + 1) spans.at(-1)[1] = Math.max(spans.at(-1)[1], range[1]);
        else spans.push(range);
      }
      const out = [];
      for (let p = 0; p < spans.length; p++) {
        if (p) out.push({n: null, text: '… 中间 ' + (spans[p][0] - spans[p - 1][1] - 1) + ' 行已折叠；TXT 导出保留全部相关行 …'});
        for (let n = spans[p][0]; n <= spans[p][1]; n++) out.push({n, text: s.lines[n - 1], highlight: n >= start && n <= end});
      }
      return out;
    }
    function detail(data, e) {
      if (!e) return null;
      const sections = [];
      const add = (side, line, endLine, description, row) => {
        const frame = frameInfo(data[side], row);
        sections.push({name: data[side].name, side, line, endLine, totalLines: data[side].lines.length, maxLineLength: data[side].maxLineLength, description, frame,
          lines: context(data[side], line, endLine, 5, frame?.anchors.map(a => a.line) || [])});
      };
      const row = ['parse', 'logLine'].includes(e.kind) ? null : data[e.source].rows[e.index];
      add(e.source, e.line, e.endLine, e.kind === 'gap' ? '缺号范围之后的报文' : '当前记录', row);
      if (e.relatedSource) add(e.relatedSource, e.relatedLine, e.relatedEndLine,
        e.kind === 'gap' ? '缺号范围之前的报文' : '关联记录', data[e.relatedSource].rows[e.relatedIndex]);
      if (e.anchorSource) { const r = data[e.anchorSource].rows[e.anchorIndex]; add(e.anchorSource, r.line, r.endLine, '顺序参照帧', r); }
      if(e.skipLine)add('raw',e.skipLine,e.skipLine,'过滤决策证据',null);
      for(const ref of e.refs||[])if(ref.source!==e.source||ref.line!==e.line)add(ref.source,ref.line,ref.endLine,'同一事件的另一处原文',null);
      return {event: e, description: descriptions(e, data), sections, frame: sections[0].frame};
    }
    function framesAtLine(s, line) {
      // A diagnostic between two fragments is not part of their byte stream.
      const m = /^\s*\d{10,16}\s*[,，]\s*([\da-f\s]+)$/i.exec(s.lines[line - 1] || '');
      if (!m || m[1].replace(/\s/g, '').length % 2) return [];
      let lo = 0, hi = s.rows.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (s.rows[mid].endLine < line) lo = mid + 1; else hi = mid; }
      const matches = [];
      for (let i = lo; i < s.rows.length && s.rows[i].line <= line; i++) matches.push(s.rows[i]);
      return matches;
    }
    function inspect(data, selection) {
      const s = data[selection?.source];
      if (!s?.lines.length) return null;
      let row = Number.isInteger(selection.index) ? s.rows[selection.index] : null;
      let line = Math.max(1, Math.min(s.lines.length, Number(selection.line) || row?.line || 1));
      const candidates = framesAtLine(s, line);
      if (!row || row.line > line || row.endLine < line || !candidates.includes(row)) row = candidates[0];
      const connectionEvent=!row&&(data.connections?.events||[]).find(e=>e.refs?.some(ref=>ref.source===s.side&&line>=ref.line&&line<=ref.endLine));
      const e = connectionEvent ? {...connectionEvent,source:s.side,line,endLine:line,index:null} : {kind: row ? 'record' : 'logLine', id: row ? 'B' + (s.side === 'raw' ? 'R' : 'F') + String(row.index + 1).padStart(6, '0') : 'L' + line,
        source: s.side, index: row?.index, line: row?.line || line, endLine: row?.endLine || line,
        t: row?.t ?? null, sid: row?.sid, cmd: row?.cmd, key: row?.key, segment: row?.segment, cycle: row?.cycle,
        connection:row?.connection,connectionKey:row?.connectionKey,appConnection:row?.appConnection,
        reason: row ? '第 ' + (row.index + 1) + ' / ' + s.rows.length + ' 条有效报文，CRC16 校验通过。浏览报文不改变异常统计。' :
          '该行没有对应的完整有效报文。保留原文，清空序号、命令 / Key 等解析字段。'};
      const d = detail(data, e);
      d.selectedLine = line;
      d.choices = candidates.map(r => ({index: r.index, sid: r.sid, cmd: r.cmd, key: r.key}));
      return {selection: {source: s.side, index: row?.index ?? null, line}, detail: d};
    }
    function logWindow(s, first = 1, count = 60) {
      const start = Math.max(1, Math.min(s.lines.length || 1, Math.floor(Number(first) || 1)));
      const length = Math.max(1, Math.min(160, Math.floor(Number(count) || 60)));
      return {side: s.side, total: s.lines.length, first: start,
        lines: s.lines.slice(start - 1, start - 1 + length).map((text, i) => ({n: start + i, text}))};
    }
    function chartConnections(s, lo, hi, wraps) {
      const rows = s.rows, groups = new Map();
      const ensure = (slot, withinFrame = false) => {
        const index = Math.min(slot, rows.length - 1), id = slot + (withinFrame ? ':inside' : ':before');
        if (index < lo || index > hi) return null;
        if (!groups.has(id)) groups.set(id, {id, index, source: s.side, afterLast: slot === rows.length,
          beforeFirst: slot === 0 && !withinFrame, withinFrame, boundary: false, events: []});
        return groups.get(id);
      };
      // Use this file's source order only. A separate diagnostic file must not supply
      // chart positions merely because its timestamps or connection IDs look similar.
      for (const e of s.connectionEvents) {
        if (!['link_loss', 'disconnected', 'connection_ready', 'session_end', 'connection_stopped'].includes(e.event)) continue;
        let a = 0, b = rows.length;
        while (a < b) { const mid = (a + b) >>> 1; if (rows[mid].endLine < e.line) a = mid + 1; else b = mid; }
        const group = ensure(a, !!rows[a] && rows[a].line < e.line);
        if (group) group.events.push({event: e.event, label: C.labels[e.event], t: e.t, line: e.line, endLine: e.endLine});
      }
      for (const wrap of wraps) {
        if (wrap.kind !== 'connection') continue;
        const group = ensure(wrap.index), row = rows[wrap.index];
        group.boundary = true;
        const resumed = group.events.some(e => ['link_loss', 'disconnected'].includes(e.event));
        group.events.push({event: 'packet', label: resumed ? '重新收到报文' : '本段首包',
          t: row.t, line: row.line, endLine: row.endLine, index: row.index});
      }
      for (const group of groups.values()) {
        group.events.sort((a, b) => a.line - b.line);
        const last = group.events.at(-1);
        const hasLoss = group.events.some(e => e.event === 'link_loss');
        const hasDisconnect = group.events.some(e => e.event === 'disconnected');
        const state = last.event === 'connection_ready' ? '连接已就绪' : hasLoss ? '连接丢失' : hasDisconnect ? '连接断开' :
          last.event === 'connection_stopped' ? '停止连接记录' : '会话结束记录';
        group.label = group.boundary ? '连接区间切换' : group.afterLast ?
          '末尾' + state : hasLoss || hasDisconnect ? '断开记录' : state;
        group.position = group.afterLast ? '最后一条报文之后' : group.withinFrame ? '第 ' + (group.index + 1) + ' 条报文分片之间' :
          group.beforeFirst ? '第一条报文之前' : '第 ' + group.index + ' / ' + (group.index + 1) + ' 条报文之间';
        group.note = group.afterLast ? '本文件此后无有效报文' : '';
      }
      return [...groups.values()].sort((a, b) => a.index - b.index || a.events[0].line - b.events[0].line);
    }
    function chart(data, mode, filter, opts = {}) {
      const side = mode === 'pair' ? opts.side || 'raw' : mode, s = data[side], rows = s?.rows||[];
      if (!rows.length) return {points: [], markers: [], wraps: [], connectionMarkers: [], total: 0, side, lo: 0, hi: 0};
      const lo = Math.max(0, Math.min(rows.length - 1, opts.lo || 0));
      const hi = Math.max(lo, Math.min(rows.length - 1, opts.hi ?? rows.length - 1));
      const budget = 900, step = Math.max(1, Math.ceil((hi - lo + 1) / budget)), points = [];
      for (let a = lo; a <= hi; a += step) {
        const b = Math.min(hi, a + step - 1);
        let mn = a, mx = a;
        for (let j = a + 1; j <= b; j++) {
          if (rows[j].sid < rows[mn].sid) mn = j;
          if (rows[j].sid > rows[mx].sid) mx = j;
        }
        for (const j of [...new Set([a, mn, mx, b])].sort((x, y) => x - y)) {
          const r = rows[j];
          points.push({index: j, sid: r.sid, line: r.line, t: r.t, cmd: r.cmd, key: r.key, segment: r.segment, cycle: r.cycle, connection:r.connection,timing: packetTiming(s, r)});
        }
      }
      const grouped = new Map();
      const all = selectEvents(data, mode, {...filter, kind: filter?.kind === 'matched' ? 'matched' : filter?.kind || 'all'});
      for (const e of all) {
        const index = e.source === side ? e.index : e.relatedSource === side ? e.relatedIndex : -1;
        if (index < lo || index > hi) continue;
        const bin = Math.floor((index - lo) / Math.max(1, hi - lo + 1) * 240);
        const key = bin + ':' + e.kind;
        const current = grouped.get(key);
        if (current) { current.count++; current.hi = Math.max(current.hi, index); }
        else grouped.set(key, {id: e.id, kind: e.kind, index, sid: rows[index].sid, count: 1, lo: index, hi: index, label: title(e) + ' ' + dualLabel(e)});
      }
      const wraps = [];
      for (let i = lo; i <= hi; i++) if (rows[i].wrap || i > 0 && rows[i].segment !== rows[i - 1].segment) wraps.push({
        index: i, sid: rows[i].sid, kind: rows[i].wrap ? 'wrap' : rows[i].boundaryKind,
        label: rows[i].wrap ? '正常回绕' : rows[i].boundaryKind==='attribution'?'连接归属变化 · 待核对':rows[i].boundaryKind==='connection'?'连接区间切换 · '+rows[i].connection:rows[i].boundaryKind === 'rollback' ? '序号跳变 · 待核对分段' : '待核对分段'});
      return {points, markers: [...grouped.values()], wraps, connectionMarkers: chartConnections(s, lo, hi, wraps), total: rows.length, side, lo, hi};
    }
    function exportParts(data, events, type, scope = '全部结果') {
      const statisticsScope=s=>s.counts.rollback||s.counts.uncertain?'按段统计；段间待核对':s.unassociatedRanges?'按连接归属范围统计；未关联报文待核对':s.connectionCount>1?'按连接统计；跨连接不比较序号':'单段统计';
      const cell = value => {
        let s = String(value ?? '');
        // Spreadsheet-safe for untrusted filenames and text beginning with a formula prefix.
        if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
      };
      if (type === 'csv') {
        const out = ['\uFEFF' + ['异常编号', '记录类型', '来源文件', '起始行', '结束行', '关联文件', '关联起始行', '关联结束行',
          '接收时间', '毫秒时间戳', '消息序号', '命令', 'Key', '可分析段', '序号周期', '缺号起始', '缺号结束', '缺号数量', '覆盖范围', '说明', '导出范围',
          '消息序号HEX', '序号原始字节LE', '缺号起始HEX', '缺号结束HEX', '前一报文序号', '前一报文序号HEX', '序号数值变化', '统计口径',
          '判定提示', '候选向前跨度', '候选向后跨度', '距上包间隔ms', '上包序号HEX', '上包起始行', '上包接收时间', '间隔说明',
          '连接会话','连接编号','连接归属依据','连接事件','状态码','重试等待ms','过滤决策原文行','连接事件原文位置'].map(cell).join(',') + '\r\n'];
        let chunk = '';
        for (const e of events) {
          const timing = packetTiming(data[e.source], ['parse', 'logLine'].includes(e.kind) ? null : data[e.source].rows[e.index]);
          chunk += [e.id, title(e), data[e.source].name, e.line, e.endLine, e.relatedSource ? data[e.relatedSource].name : '',
            e.relatedLine, e.relatedEndLine, timestamp(e.t), e.t, e.sid, hexByte(e.cmd), hexByte(e.key), e.segment, e.cycle,
            e.from, e.to, e.count, e.coverage === 'inside' ? '共有范围内' : e.coverage === 'outside' ? '共有范围外' : e.coverage === 'unknown' ? '无共有范围' : '',
            descriptions(e, data), scope, hexWord(e.sid), sequenceBytes(e.sid), hexWord(e.from), hexWord(e.to),
            e.previousSid, hexWord(e.previousSid), e.numericDelta,
            statisticsScope(data[e.source]), e.directionHint,
            e.forwardDistance, e.backwardDistance, timing?.ms, hexWord(timing?.previous?.sid), timing?.previous?.line,
            timestamp(timing?.previous?.t), timing?.hint,e.connection,e.appConnection,e.connectionEvidence||e.group?.evidence,
            e.event,e.status,e.fields?.delay_ms,e.skipLine,(e.refs||[]).map(r=>data[r.source].name+':L'+r.line+(r.endLine!==r.line?'–L'+r.endLine:'')).join('；')].map(cell).join(',') + '\r\n';
          if (chunk.length > 262144) { out.push(chunk); chunk = ''; }
        }
        if (chunk) out.push(chunk);
        return out;
      }
      const out = ['AB 日志分析 · 原始片段\r\n导出范围：' + scope + '；记录数：' + events.length +
        '\r\n序号按完整文件、源行顺序计算；缺号不直接等于通信丢包。\r\n' +
        Object.values(data).filter(s => s.rows).map(s => s.name + '：' + s.segments + ' 个可分析段；' +
          statisticsScope(s)+'；'+(s.segments > 1 ? '仅统计段内缺号，缺号为 0 不代表整份日志完整。' : '不推测文件首尾以外的序号。')).join('\r\n') + '\r\n\r\n'];
      let chunk = '';
      for (const e of events) {
        chunk += '[' + e.id + '] ' + title(e) + ' ' + (e.kind==='connection'?'':dualLabel(e)) + '\r\n' + descriptions(e, data) + '\r\n连接会话：'+(e.connection||'待核对')+'\r\n';
        const spans = [[e.source, e.line, e.endLine, e.kind === 'parse' ? null : e.index]];
        if (e.relatedSource) spans.push([e.relatedSource, e.relatedLine, e.relatedEndLine, e.relatedIndex]);
        if(e.skipLine)spans.push(['raw',e.skipLine,e.skipLine,null]);
        for(const ref of e.refs||[])if(ref.source!==e.source||ref.line!==e.line)spans.push([ref.source,ref.line,ref.endLine,null]);
        if (e.anchorSource) { const r = data[e.anchorSource].rows[e.anchorIndex]; spans.push([e.anchorSource, r.line, r.endLine, r.index]); }
        for (const [side, start, end, index] of spans) {
          const s = data[side];
          chunk += s.name + '（L' + start + '–L' + end + '）\r\n';
          if (index != null) {
            const row = s.rows[index];
            chunk += '报文序号：' + hexWord(row.sid) + ' = ' + row.sid + '（十进制）；原始字节：' + sequenceBytes(row.sid) +
              '（小端，AB 帧内偏移 6、7）\r\n命令 / Key：' + (hexByte(row.cmd) || '—') + ' / ' + (hexByte(row.key) || '—') + '\r\n' +
              timingText(packetTiming(s, row)) + '\r\n';
          }
          for (let n = Math.max(1, start - 5); n <= Math.min(s.lines.length, end + 5); n++) {
            chunk += 'L' + n + '  ' + s.lines[n - 1] + '\r\n';
            if (chunk.length > 262144) { out.push(chunk); chunk = ''; }
          }
        }
        chunk += '\r\n----------------------------------------\r\n\r\n';
      }
      if (chunk) out.push(chunk);
      return out;
    }
    return {parse, compare, summary, crc16, makeFrame, names, title, label, timestamp,connections:C.timeline,connectionLabels:C.labels,
      selectEvents, detail, inspect, framesAtLine, logWindow, chart, descriptions, exportParts, hexByte, hexWord, sequenceBytes, hexLabel, dualLabel, sequenceSource, packetTiming, timingText};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = createEngine(require('./connections.js'));
  else { root.ABEngineFactory = createEngine; root.ABEngine = createEngine(root.ABConnections); }
})(typeof globalThis === 'undefined' ? self : globalThis);
