const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const E = require('../dist/engine.js');
// Independent bit-at-a-time encoder; production uses a lookup table.
function frame(sid, body = [0x7b, 3, 0x12, 0], flags = 0) {
  let c = 0;
  for (const byte of body) {
    c ^= byte << 8;
    for (let i = 0; i < 8; i++) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
  }
  return Buffer.from([0xab, flags, body.length & 255, body.length >>> 8, c & 255, c >>> 8, sid & 255, sid >>> 8, ...body]).toString('hex');
}
const base = 1800000000000;
const lines = ids => ids.map((id, i) => (base + i) + ',' + (typeof id === 'number' ? frame(id) : id)).join('\n');
const parse = (ids, side = 'raw') => E.parse(lines(ids), side + '.txt', side);
const kinds = (s, type) => s.events.filter(e => e.kind === type);
const zeros = s => {
  for (const k of ['gap', 'reorder', 'duplicate', 'collision', 'parse', 'uncertain']) assert.equal(s.counts[k], 0, k);
};
test('CRC16 XMODEM known check value', () => assert.equal(E.crc16(Buffer.from('123456789')), 0x31c3));
test('V01 continuous sequence', () => { const s = parse([100,101,102]); zeros(s); assert.equal(s.counts.frames, 3); });
test('V02 final missing range', () => { const s = parse([100,102,103]); assert.equal(s.counts.gap, 1); assert.equal(kinds(s,'gap')[0].from,101); });
test('V03 late arrival removes a candidate gap', () => { const s = parse([100,102,101,103]); assert.equal(s.counts.gap,0); assert.equal(s.counts.reorder,1); });
test('V04 partial replenishment keeps only unseen IDs', () => {
  const s = parse([100,103,102,104]); assert.equal(s.counts.gap,1); assert.equal(kinds(s,'gap')[0].from,101); assert.equal(s.counts.reorder,1);
});
test('V05 duplicate points at earlier identical frame', () => {
  const s = parse([100,101,101,102]); assert.equal(s.counts.duplicate,1); assert.equal(kinds(s,'duplicate')[0].relatedLine,2); assert.equal(s.counts.gap,0);
});
test('V06 differing same-ID frame stays separate; repeat of variant is duplicate', () => {
  const a=frame(101), b=frame(101,[1,3,0x23,5]); const s=parse([a,b,b,a]);
  assert.equal(s.counts.collision,1); assert.equal(s.counts.duplicate,2); assert.equal(kinds(s,'duplicate')[0].relatedLine,2);
});
test('V07 wrap and wrap-spanning late arrival', () => {
  const s = parse([65534,65535,0,1]); zeros(s); assert.equal(s.wraps,1);
  const late = parse([65534,0,65535,1]); assert.equal(late.counts.reorder,1); assert.equal(late.counts.gap,0);
});
test('gap crossing 65535 splits ranges without losing zero', () => {
  const s = parse([65533,2]); assert.equal(s.counts.gap,4); assert.deepEqual(kinds(s,'gap').map(e=>[e.from,e.to]),[[65534,65535],[0,1]]);
});
test('V08 no missing IDs outside observed boundaries', () => zeros(parse([33796,33797,33798])));
test('late arrivals before first logged sequence do not create a false gap or segment', () => {
  for(const ids of [[100,99,101],[102,100,101,103]]) {
    const s=parse(ids); assert.equal(s.counts.gap,0); assert.equal(s.counts.uncertain,0); assert.equal(s.segments,1);
    assert.equal(s.counts.reorder,ids.length-2);
  }
});
test('leading late arrivals can come from the preceding wrap cycle', () => {
  const s=parse([1,65535,0,2]);
  assert.equal(s.counts.gap,0); assert.equal(s.counts.reorder,2); assert.equal(s.counts.uncertain,0); assert.equal(s.wraps,1);
});
test('V09 all commands share sequence; display filters do not change statistics', () => {
  const s=parse([frame(100,[1,3,2,3]),frame(101,[0x7b,3,4,5]),frame(103,[1,3,2,3])]);
  assert.equal(s.counts.gap,1); assert.equal(E.selectEvents({raw:s},'raw',{command:0x7b}).length,0); assert.equal(s.counts.gap,1);
});
test('V10 pairing filtered omission is factual; preserve matching original timestamps', () => {
  const raw=E.parse(lines([100,101,102]),'r.txt','raw');
  const filtered=E.parse(lines([100,101,102]).split('\n').filter((_,i)=>i!==1).join('\n'),'f.txt','filtered');
  const p=E.compare(raw,filtered);
  assert.equal(raw.counts.gap,0); assert.equal(filtered.counts.gap,1); assert.equal(p.counts.matched,2);
  assert.equal(p.counts.rawOnly,1); assert.equal(p.counts.inside,1); assert.equal(p.counts.filteredOnly,0);
});
test('V11 temporal coverage identifies leading and trailing differences', () => {
  const text=lines([100,101,102,103,104]); const raw=E.parse(text,'r','raw'), filtered=E.parse(text.split('\n').slice(1,4).join('\n'),'f','filtered');
  const p=E.compare(raw,filtered); assert.equal(p.counts.outside,2); assert.equal(p.counts.inside,0);
});
test('V12 split frames, diagnostics, CRLF and multiple frames per line retain physical lines', () => {
  const a=frame(100),b=frame(101),c=frame(102);
  const text='\uFEFF\r\n'+base+','+a.slice(0,6)+'\r\nerror 消息序号中断\r\n\r\n'+(base+1)+','+a.slice(6)+b+c+'\r\n';
  const s=E.parse(text);
  assert.equal(s.rows.length,3); zeros(s); assert.equal(s.rows[0].line,2); assert.equal(s.rows[0].endLine,5);
  assert.equal(s.rows[1].line,5); assert.equal(s.rows[2].line,5); assert.equal(s.rows[0].t,base);
  assert.equal(s.diagnostics,1); assert.equal(s.lines.length,5);
});
test('V13 bad CRC, invalid hex, bogus length and final partial frame do not pollute valid sequence', () => {
  const good=frame(100),bad=frame(65000).slice(0,-2)+'01', next=frame(101);
  const s=E.parse(base+','+good+'\n'+(base+1)+','+bad+'\n'+(base+2)+',abxx\n'+(base+3)+','+next+'\n'+(base+4)+',ab0004');
  assert.deepEqual(s.rows.map(r=>r.sid),[100,101]); assert.equal(s.counts.gap,0); assert.ok(s.counts.parse>=3);
  const long=frame(60000).slice(0,4)+'ffff'+frame(60000).slice(8), recovered=E.parse(lines([good,long,next]));
  assert.deepEqual(recovered.rows.map(r=>r.sid),[100,101]); assert.ok(recovered.counts.parse);
});
test('malformed record breaks pending byte assembly', () => {
  const h=frame(500); const s=E.parse(base+','+h.slice(0,6)+'\n'+base+',xx\n'+base+','+h.slice(6)+'\n'+base+','+frame(501));
  assert.deepEqual(s.rows.map(r=>r.sid),[501]); assert.ok(s.counts.parse);
});
test('V14 export includes zero gap, true source lines and both sides', () => {
  const s=parse([65535,1]), e=kinds(s,'gap')[0], data={raw:s};
  const csv=E.exportParts(data,s.events,'csv').join(''), txt=E.exportParts(data,s.events,'txt').join('');
  assert.equal(e.from,0); assert.ok(csv.startsWith('\uFEFF')); assert.match(csv,/"0","0","1"/);
  assert.ok(txt.includes('[R00001]')); assert.ok(txt.includes('L1  '+base)); assert.ok(txt.includes('L2  '+(base+1)));
  assert.equal(E.detail(data,e).sections.length,2); assert.ok(E.chart(data,'raw',{},{}).markers.some(m=>m.id===e.id));
});
test('V15 more than two cycles do not create duplicates', () => {
  const ids=Array.from({length:131077},(_,i)=>(65534+i)&65535);
  const s=parse(ids); zeros(s); assert.equal(s.wraps,3); assert.equal(s.rows.at(-1).cycle,3);
});
test('unresolvable large jump does not create false missing IDs', () => {
  const s=parse([100,60000,60001]); assert.equal(s.counts.uncertain,1); assert.equal(s.counts.gap,0); assert.equal(s.segments,2);
  const half=parse([0,32768]); assert.equal(half.counts.uncertain,1);
});
test('pair comparison preserves occurrences and marks ambiguous correspondence', () => {
  const a=base+','+frame(100),b=(base+1)+','+frame(101);
  const r=E.parse(a+'\n'+a+'\n'+b,'r','raw'),f=E.parse(a+'\n'+b,'f','filtered'),p=E.compare(r,f);
  assert.equal(p.counts.matched,2); assert.equal(p.counts.rawOnly,1); assert.equal(p.counts.pairUncertain,1); assert.equal(p.counts.pairOrder,0);
});
test('pair relative order and filtered-only records', () => {
  const text=lines([100,101,102]).split('\n');
  const r=E.parse(text.join('\n'),'r','raw'),f=E.parse([text[0],text[2],text[1],(base+3)+','+frame(103)].join('\n'),'f','filtered');
  const p=E.compare(r,f); assert.equal(p.counts.pairOrder,1); assert.equal(p.counts.filteredOnly,1);
  const event=p.events.find(e=>e.kind==='pairOrder'); assert.equal(E.detail({raw:r,filtered:f},event).sections.length,3);
});
test('timestamp mismatch is not silently paired by sequence alone', () => {
  const r=parse([100]),f=E.parse((base+100)+','+frame(100),'f','filtered'),p=E.compare(r,f);
  assert.equal(p.counts.matched,0); assert.equal(p.counts.rawOnly,1); assert.equal(p.counts.filteredOnly,1); assert.equal(p.counts.unknown,2);
});
test('empty and diagnostic-only logs yield no fabricated frames', () => { zeros(E.parse('')); const s=E.parse('error <script>abc</script>\n\nnote'); zeros(s); assert.equal(s.diagnostics,2); });
test('search matches missing IDs, hex, source lines and fixed timezone', () => {
  const s=parse([100,105]),d={raw:s};
  for(const query of ['103','0x67','L2',E.timestamp(s.rows[1].t).slice(0,10)]) assert.equal(E.selectEvents(d,'raw',{query}).length,1);
});
test('CSV formula prefixes in filenames are neutralized', () => {
  const s=E.parse(lines([100,102]),'=1+1.txt'); assert.ok(E.exportParts({raw:s},s.events,'csv').join('').includes("\"'=1+1.txt\""));
});
test('overview groups anomaly marks without dropping event counts', () => {
  const s=parse(Array.from({length:2500},(_,i)=>i*2)), c=E.chart({raw:s},'raw',{},{}); const total=c.markers.reduce((n,m)=>n+m.count,0);
  assert.equal(total,s.events.length); assert.ok(c.points.length<=3600);
});
test('large fragmented frame exports full context while UI folds middle', () => {
  const h=frame(100,new Array(120).fill(4)); const text=h.match(/../g).map((b,i)=>(base+i)+','+b).join('\n');
  const s=E.parse(text+'\n'+(base+500)+','+frame(102)),d={raw:s},e=s.events[0];
  assert.ok(E.detail(d,e).sections.some(section=>section.lines.some(l=>l.n==null)));
  assert.ok(E.exportParts(d,s.events,'txt').join('').includes('L80  '));
});
if(process.env.AB_RAW_LOG && process.env.AB_FILTER_LOG) {
  test('supplied logs reproduce verified baseline', () => {
    const raw=E.parse(fs.readFileSync(process.env.AB_RAW_LOG,'utf8'),'abBle.txt','raw');
    const filtered=E.parse(fs.readFileSync(process.env.AB_FILTER_LOG,'utf8'),'abFilter.txt','filtered');
    const pair=E.compare(raw,filtered);
    assert.equal(raw.counts.frames,399); assert.equal(raw.counts.gap,142); assert.equal(raw.counts.parse,0);
    assert.equal(raw.counts.reorder,0); assert.equal(raw.counts.duplicate,0); assert.equal(raw.counts.collision,1);
    assert.equal(filtered.counts.frames,231); assert.equal(filtered.counts.gap,54); assert.equal(filtered.counts.parse,0);
    assert.equal(pair.counts.matched,231); assert.equal(pair.counts.rawOnly,168); assert.equal(pair.counts.filteredOnly,0);
    assert.equal(pair.counts.outside,167); assert.equal(pair.counts.inside,1);
    assert.deepEqual(kinds(raw,'collision').map(e=>[e.sid,e.relatedLine,e.line]),[[33945,302,304]]);
  });
}
