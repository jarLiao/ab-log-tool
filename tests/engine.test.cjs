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
  for (const k of ['gap', 'reorder', 'duplicate', 'collision', 'parse', 'uncertain', 'rollback']) assert.equal(s.counts[k], 0, k);
};
test('CRC16 XMODEM known check value', () => assert.equal(E.crc16(Buffer.from('123456789')), 0x31c3));

test('packet interval follows valid reception order across commands and sequence disorder', () => {
  const s=E.parse([base+','+frame(100),(base+20)+','+frame(102,[1,3,0x15,0]),'diagnostic',(base+75)+','+frame(101)].join('\n'));
  assert.equal(E.packetTiming(s,s.rows[0]).ms,null);
  const timing=E.packetTiming(s,s.rows[2]);
  assert.equal(timing.ms,55); assert.equal(timing.previous.sid,102); assert.equal(timing.previous.line,2);
  assert.equal(E.detail({raw:s},s.events[0]).frame.timing.ms,55);
  assert.equal(E.chart({raw:s},'raw',{command:'123'}).points.at(-1).timing.ms,55);
});

test('fragment timestamps use first fragment and same-line frames have zero interval', () => {
  const first=frame(100),second=frame(101),third=frame(102);
  const s=E.parse(base+','+first.slice(0,14)+'\n'+(base+50)+','+first.slice(14)+second+third);
  assert.deepEqual(s.rows.map(row=>E.packetTiming(s,row).ms),[null,50,0]);
  assert.ok(E.packetTiming(s,s.rows[2]).hint.includes('相同'));
});

test('timestamp rollback and segment boundaries retain actual signed receive-time difference', () => {
  const s=E.parse([base+','+frame(0),(base-8)+','+frame(32768),(base+1200)+','+frame(32769)].join('\n'));
  assert.equal(s.segments,2);
  const t=E.packetTiming(s,s.rows[1]);
  assert.equal(t.ms,-8); assert.equal(t.acrossSegment,true); assert.ok(t.hint.includes('时间戳回退'));
  assert.equal(E.packetTiming(s,s.rows[2]).label,'1208 ms（1.208 s）');
});

test('gap intervals use the actual preceding received packet, not the sequence-range anchor', () => {
  const s=E.parse([100,104,102,105].map((id,i)=>(base+i*10)+','+frame(id)).join('\n'));
  const gap=s.events.find(e=>e.kind==='gap'&&e.from===101),d=E.detail({raw:s},gap);
  assert.equal(d.sections[1].frame.sid,100);
  assert.equal(d.frame.timing.previous.sid,104); assert.equal(d.frame.timing.ms,10);
});

test('corrupt and diagnostic rows have no packet interval, while valid packets skip corrupt rows', () => {
  const bad=frame(101).slice(0,-2)+'ff';
  const s=E.parse(base+','+frame(100)+'\n'+(base+10)+','+bad+'\n'+(base+40)+','+frame(102));
  assert.equal(E.detail({raw:s},s.events.find(e=>e.kind==='parse')).frame,null);
  assert.equal(E.packetTiming(s,s.rows[1]).ms,40);
  s.rows[1].t=Number.MAX_SAFE_INTEGER+1;
  assert.equal(E.packetTiming(s,s.rows[1]).ms,null);
});

test('interval exports preserve zero and negative numbers and describe each source independently', () => {
  const s=E.parse([base+','+frame(100),base+','+frame(100),(base-10)+','+frame(100)].join('\n'));
  const csv=E.exportParts({raw:s},s.events,'csv').join('');
  const rows=csv.trim().replace(/^\uFEFF/,'').split('\r\n').map(line=>line.slice(1,-1).split('\",\"'));
  const header=rows.shift(),field=(r,key)=>r[header.indexOf(key)];
  assert.equal(field(rows[0],'距上包间隔ms'),'0'); assert.equal(field(rows[1],'距上包间隔ms'),'-10');
  assert.equal(field(rows[1],'上包起始行'),'2');
  const txt=E.exportParts({raw:s},s.events,'txt').join('');
  assert.ok(txt.includes('与上包间隔：-10 ms')); assert.ok(txt.includes('时间戳回退'));
  const filtered=E.parse((base+100)+','+frame(100),'filtered.txt','filtered'),pair=E.compare(s,filtered);
  const data={raw:s,filtered,pair};
  const only=pair.events.find(e=>e.source==='filtered');
  assert.equal(E.detail(data,only).frame.timing.previous,null);
});
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
  for (const index of [32768, 65536, 131076]) {
    const anchors = E.sequenceSource(s, s.rows[index]);
    assert.equal(anchors[0].line, index + 1);
    assert.equal(anchors[0].start, 26);
    assert.equal(s.lines[index].slice(26,30), frame(ids[index]).slice(12,16));
  }
});
test('unresolvable large jump does not create false missing IDs', () => {
  const s=parse([100,60000,60001]); assert.equal(s.counts.uncertain,1); assert.equal(s.counts.gap,0); assert.equal(s.segments,2);
  const half=parse([0,32768]); assert.equal(half.counts.uncertain,1);
});
const series = (start, count, version = 0) => Array.from({length:count}, (_,i) => frame((start+i)&65535,[0x7b,3,0x11,version]));

test('sustained sequence reuse is separated instead of thousands of late and conflicting frames', () => {
  const runs=[[48889,6480],[47985,43],[47986,44],[47987,17],[47988,9],[47989,51],[47990,21244]];
  const s=parse(runs.flatMap(([sid,count],i)=>series(sid,count,i)));
  assert.equal(s.counts.frames,27888); assert.equal(s.counts.rollback,6); assert.equal(s.segments,7);
  for(const key of ['gap','reorder','duplicate','collision','parse','uncertain']) assert.equal(s.counts[key],0,key);
  assert.equal(s.wraps,1);
  assert.deepEqual(kinds(s,'rollback').map(e=>[e.previousSid,e.sid,e.segment]),[[55368,47985,2],[48027,47986,3],[48029,47987,4],[48003,47988,5],[47996,47989,6],[48039,47990,7]]);
  assert.deepEqual(s.segmentRanges.map(p=>p.frames),runs.map(r=>r[1]));
});

test('a batch filling a known gap remains late arrivals, not a sequence rollback', () => {
  const s=parse([100,110,101,102,103,104,105,106,107,108,109,111]);
  assert.equal(s.counts.gap,0); assert.equal(s.counts.reorder,9); assert.equal(s.counts.rollback,0); assert.equal(s.segments,1);
});

test('identical replay and isolated differing content retain their original meaning', () => {
  const a=series(100,8);
  const replay=parse([...a,...a]); assert.equal(replay.counts.duplicate,8); assert.equal(replay.counts.rollback,0);
  const collision=parse([...a,frame(103,[0x7b,3,0x11,2]),108,109,110,111]);
  assert.equal(collision.counts.collision,1); assert.equal(collision.counts.rollback,0);
});

test('an earlier segment cannot fill a missing sequence in a later reused range', () => {
  const s=parse([...series(100,11),...series(100,4,1),...series(105,5,1)]);
  assert.equal(s.counts.rollback,1); assert.equal(s.counts.gap,1);
  const gap=kinds(s,'gap')[0]; assert.equal(gap.from,104); assert.equal(gap.segment,2);
  assert.equal(s.rows[gap.relatedIndex].segment,2); assert.equal(s.rows[gap.index].segment,2);
});

test('a large leading rollback needs sustained progress and has correct segment metadata', () => {
  const s=parse([...series(10000,4),...series(100,4)]);
  assert.equal(s.counts.rollback,1); assert.equal(s.counts.reorder,0); assert.equal(s.counts.gap,0);
  const e=kinds(s,'rollback')[0]; assert.equal(e.segment,2); assert.equal(e.cycle,0);
  assert.equal(E.detail({raw:s},e).sections[1].frame.sid,10003);
  const uncertain=parse([100,60000,60001]);
  assert.equal(kinds(uncertain,'uncertain')[0].segment,2);
});

test('rollback reports, search and chart retain both boundary anchors and conditional gap scope', () => {
  const s=parse([...series(10000,4),...series(100,4)]),e=kinds(s,'rollback')[0],data={raw:s};
  assert.equal(E.selectEvents(data,'raw',{query:'10003'}).length,1);
  assert.equal(E.selectEvents(data,'raw',{query:'0x0064'}).length,1);
  assert.ok(E.hexLabel(e).includes('0x2713')); assert.ok(E.hexLabel(e).includes('0x0064'));
  assert.ok(E.chart(data,'raw',{},{}).wraps.some(w=>w.label.includes('跳变')));
  const csv=E.exportParts(data,s.events,'csv').join(''),txt=E.exportParts(data,s.events,'txt').join('');
  assert.ok(csv.includes('前一报文序号HEX')); assert.ok(csv.includes('段间待核对'));
  assert.ok(txt.includes('段间待核对')); assert.ok(txt.includes('0x2713'));
});

test('normal rollover is continuous even when content changes', () => {
  const s=parse([frame(65534),frame(65535,[0x7b,3,1,1]),frame(0,[0x7b,3,1,2]),frame(1)]);
  zeros(s); assert.equal(s.wraps,1); assert.equal(s.segments,1);
});

test('ascending large jump is an unresolved boundary, not a confirmed rollback', () => {
  // Reproduce the visible sequence pattern, without using or embedding the source log.
  const runs=[[50752,24277],[47995,330],[47996,2220]];
  const s=parse(runs.flatMap(([sid,count],i)=>series(sid,count,i))),events=kinds(s,'rollback');
  assert.equal(s.counts.frames,26827); assert.equal(s.segments,3); assert.equal(events.length,2);
  assert.equal(s.counts.gap,0); assert.equal(s.counts.reorder,0); assert.equal(s.counts.collision,0);
  const [up,down]=events;
  assert.deepEqual([up.previousSid,up.sid,up.numericDelta,up.forwardDistance,up.backwardDistance],[9492,47995,38503,38503,27033]);
  assert.equal(up.directionHint,'方向待核对'); assert.equal(up.backwardBy,undefined);
  assert.equal(E.title(up),'序号跳变待核对');
  assert.ok(up.reason.includes('数值增大 38503')); assert.ok(up.reason.includes('不能确认方向')); assert.ok(!up.reason.includes('回退到'));
  assert.deepEqual([down.previousSid,down.sid,down.numericDelta],[48324,47996,-328]);
  assert.equal(down.directionHint,'原因待核对'); assert.ok(down.reason.includes('数值减小 328'));
});

test('a half-cycle ambiguity exposes both real anchors and equal candidate distances', () => {
  const s=parse([0,32768]),e=kinds(s,'uncertain')[0];
  assert.equal(e.forwardDistance,32768); assert.equal(e.backwardDistance,32768);
  assert.equal(e.directionHint,'方向待核对'); assert.equal(E.hexLabel(e),'0x0000 → 0x8000');
  assert.equal(E.selectEvents({raw:s},'raw',{query:'0x0000'})[0],e);
});

test('boundary exports separate signed observed change from hypothetical distances', () => {
  const s=parse([...series(9492,1),...series(47995,330),...series(47996,4,2)]),data={raw:s};
  const events=s.events.filter(e=>e.previousSid!=null);
  const csv=E.exportParts(data,events,'csv').join(''),txt=E.exportParts(data,events,'txt').join('');
  const rows=csv.trim().replace(/^\uFEFF/,'').split('\r\n').map(line=>line.slice(1,-1).split('","').map(cell=>cell.replace(/""/g,'"')));
  const header=rows.shift(),field=(row,name)=>row[header.indexOf(name)];
  assert.ok(!header.includes('回退幅度')); assert.ok(!header.includes('回退前序号'));
  assert.equal(field(rows[0],'序号数值变化'),'38503'); assert.equal(field(rows[0],'候选向后跨度'),'27033');
  assert.equal(field(rows[0],'判定提示'),'方向待核对');
  assert.equal(field(rows[1],'序号数值变化'),'-328'); assert.equal(field(rows[1],'统计口径'),'按段统计；段间待核对');
  assert.ok(txt.includes('数值增大 38503')); assert.ok(txt.includes('不能确认方向')); assert.ok(!txt.includes('回退到'));
});

test('normal record inspection exposes its own command and key without adding anomalies', () => {
  const s=parse([frame(100,[0x7b,3,0x11,0]),frame(101,[0x01,3,0x15,0])]);
  const before=JSON.stringify(s.counts), inspected=E.inspect({raw:s},{source:'raw',index:1});
  assert.equal(inspected.detail.frame.sid,101); assert.equal(inspected.detail.frame.cmd,'0x01'); assert.equal(inspected.detail.frame.key,'0x15');
  assert.equal(inspected.detail.frame.index,1); assert.equal(inspected.detail.frame.total,2);
  assert.equal(inspected.detail.sections[0].line,2); assert.equal(JSON.stringify(s.counts),before); assert.equal(s.events.length,0);
});

test('line selection resolves all frames on one line and keeps fragmented frame identity', () => {
  const a=frame(100),b=frame(101,[0x01,3,0x16,0]);
  const s=E.parse(base+','+a.slice(0,14)+'\nerror between fragments\n'+(base+1)+','+a.slice(14)+b);
  assert.deepEqual(E.framesAtLine(s,3).map(r=>r.sid),[100,101]);
  assert.equal(E.inspect({raw:s},{source:'raw',line:3,index:0}).detail.frame.sid,100);
  const chosen=E.inspect({raw:s},{source:'raw',line:3,index:1});
  assert.equal(chosen.detail.frame.sid,101); assert.equal(chosen.detail.frame.key,'0x16');
  assert.deepEqual(chosen.detail.choices.map(r=>r.index),[0,1]);
  assert.equal(E.inspect({raw:s},{source:'raw',line:2}).detail.frame,null);
});

test('diagnostic, blank and corrupt rows clear the parsed fields instead of using a nearby frame', () => {
  const s=E.parse(base+','+frame(100)+'\n\nerror device note\n'+(base+1)+',AB0001000000650001');
  for(const line of [2,3,4]) {
    const value=E.inspect({raw:s},{source:'raw',line,index:0});
    assert.equal(value.detail.frame,null); assert.equal(value.detail.event.kind,'logLine');
    assert.equal(value.detail.event.sid,undefined); assert.equal(value.detail.sections[0].line,line);
  }
});

test('whole-log windows retain unmodified physical lines and bound each transfer', () => {
  const input=Array.from({length:2000},(_,i)=>i%2 ? 'diagnostic '+i : (base+i)+','+frame(i)).join('\r\n');
  const s=E.parse(input);
  const middle=E.logWindow(s,1001,100000);
  assert.equal(middle.total,2000); assert.equal(middle.lines.length,160);
  assert.equal(middle.lines[0].text,input.split('\r\n')[1000]); assert.equal(middle.lines[0].n,1001);
  assert.equal(E.logWindow(s,2000).lines[0].text,'diagnostic 1999');
  assert.equal(E.logWindow(s,3000).lines[0].n,2000);
  assert.equal(E.detail({raw:s},s.events[0]).sections[0].totalLines,2000);
});

if(process.env.AB_ROLLBACK_LOG) test('reported rollback log contains six distinct counter transitions', () => {
  const s=E.parse(fs.readFileSync(process.env.AB_ROLLBACK_LOG,'utf8'));
  assert.equal(s.counts.frames,27888); assert.equal(s.counts.rollback,6); assert.equal(s.segments,7);
  assert.equal(s.counts.gap,0); assert.equal(s.counts.reorder,0); assert.equal(s.counts.collision,0);
  assert.deepEqual(kinds(s,'rollback').map(e=>e.line),[12962,13136,13314,13384,13422,13628]);
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
test('hexadecimal sequence labels and little-endian bytes have explicit leading zeros', () => {
  assert.equal(E.hexWord(33796),'0x8404'); assert.equal(E.sequenceBytes(33796),'04 84');
  assert.equal(E.hexWord(0),'0x0000'); assert.equal(E.sequenceBytes(0),'00 00');
  assert.equal(E.hexWord(65535),'0xFFFF'); assert.equal(E.sequenceBytes(65535),'FF FF');
});
test('missing ID has no invented raw frame: anchors point at the two actual neighbors', () => {
  const s=parse([33796,33798]),d=E.detail({raw:s},s.events[0]);
  assert.equal(E.hexLabel(d.event),'0x8405');
  assert.deepEqual(d.sections.map(section=>[section.frame.sidHex,section.frame.seqBytes]),[['0x8406','06 84'],['0x8404','04 84']]);
  for(const section of d.sections) for(const a of section.frame.anchors) assert.equal(s.lines[a.line-1].slice(a.start,a.end).toUpperCase(),a.value);
  assert.equal(d.sections[0].frame.anchors[0].start,26);
});
test('two sequence bytes can originate in separate fragments and source lines', () => {
  const a=frame(33796),b=frame(33798);
  const text=base+','+a.slice(0,14)+'\nerror diagnostic\n'+(base+1)+','+a.slice(14)+b;
  const s=E.parse(text);
  const anchors=E.sequenceSource(s,s.rows[0]);
  assert.deepEqual(anchors.map(a=>[a.line,a.start,a.value]),[[1,26,'04'],[3,14,'84']]);
  const second=E.sequenceSource(s,s.rows[1]);
  assert.equal(second[0].start,14+a.length-14+12);
  assert.equal(s.lines[2].slice(second[0].start,second[0].end),'06');
});
test('original whitespace and split hexadecimal nibbles retain exact source columns', () => {
  const h=frame(33796), text='  '+base+' , \t'+h.split('').join(' \t')+'  ';
  const s=E.parse(text),anchors=E.sequenceSource(s,s.rows[0]);
  assert.equal(s.lines[0],text);
  assert.deepEqual(anchors.map(a=>text.slice(a.start,a.end).replace(/\s/g,'').toUpperCase()),['04','84']);
});
test('same bytes elsewhere in a payload are never used as sequence anchors', () => {
  const a=frame(10,[0x7b,3,0x04,0x84]),b=frame(33796);
  const text=base+','+a+b,s=E.parse(text),anchors=E.sequenceSource(s,s.rows[1]);
  assert.equal(anchors[0].start,14+a.length+12);
  assert.notEqual(anchors[0].start,text.indexOf('0484'));
  assert.equal(text.slice(anchors[0].start,anchors[1].end),'0484');
});
test('a sequence field in the folded middle of a long fragmented frame remains visible', () => {
  const h=frame(33796,new Array(120).fill(4));
  const rows=[base+','+h.slice(0,12),...new Array(60).fill('error delay'),base+','+h.slice(12,14),
    ...new Array(12).fill('error delay'),base+','+h.slice(14,16),...new Array(120).fill('error delay'),
    base+','+h.slice(16),base+','+frame(33798)];
  const s=E.parse(rows.join('\n')),d=E.detail({raw:s},s.events[0]),previous=d.sections[1];
  for(const anchor of previous.frame.anchors) assert.ok(previous.lines.some(l=>l.n===anchor.line));
});
test('a CRC-invalid frame has no trusted sequence highlight', () => {
  const bad=frame(33796).slice(0,-2)+'01',s=E.parse(lines([bad,frame(33798)])),e=s.events.find(e=>e.kind==='parse');
  const d=E.detail({raw:s},e); assert.equal(d.frame,null); assert.equal(d.sections[0].frame,null);
});
test('exports include HEX, decimal and original little-endian byte correspondence', () => {
  const s=parse([33796,33798]),data={raw:s},csv=E.exportParts(data,s.events,'csv').join(''),txt=E.exportParts(data,s.events,'txt').join('');
  assert.ok(csv.includes('"消息序号HEX","序号原始字节LE","缺号起始HEX","缺号结束HEX"'));
  assert.ok(csv.includes('"0x8406","06 84","0x8405","0x8405"'));
  assert.ok(txt.includes('0x8404 = 33796（十进制）；原始字节：04 84'));
  assert.ok(txt.includes('0x8405（DEC 33797）'));
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
