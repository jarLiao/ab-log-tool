/* Connection evidence is separate from sequence heuristics. No DOM or network. */
(function (root) {
  'use strict';
  function createConnections() {
    const labels = {process_start:'应用启动', connect_attempt:'开始连接', link_connected:'链路已连接',
      connection_ready:'连接已就绪', session_start:'收包会话开始', session_end:'收包会话结束',
      first_packet:'首次观察到有效报文', disconnected:'连接已断开', link_loss:'连接丢失',
      connection_failed:'连接失败', retry_scheduled:'等待重试', retries_exhausted:'重试已耗尽',
      connection_stopped:'连接已停止', error:'连接错误', mtu:'MTU 更新', adapter_state:'蓝牙状态',
      notification_ignored:'忽略旧连接通知', processing_error:'收包处理错误', gatt:'GATT 诊断'};
    const closing = new Set(['disconnected','link_loss','connection_failed','connection_stopped','retries_exhausted']);
    function read(text, line, source) {
      const s = text.trim();
      let m = /^(ble_session|ble_event|reorder_skip|record_event)\s+(\d{10,16})\s*,\s*(.*)$/.exec(s);
      if (m) {
        const fields = {};
        for (const pair of m[3].split(/,\s*/)) {
          const p = pair.indexOf('='); if (p > 0) fields[pair.slice(0,p).trim()] = pair.slice(p+1).trim();
        }
        if (m[1] === 'record_event') return {diagnostic:true};
        if (m[1] === 'reorder_skip') return {skip:true,t:Number(m[2]),line,source,from:Number(fields.from),to:Number(fields.to),reason:fields.reason};
        const event = m[1] === 'ble_session' ? 'session_' + fields.event : fields.event;
        if (!event) return {diagnostic:true};
        const e = {kind:'connection',event,source,line,endLine:line,t:Number(m[2]),appConnection:fields.connection || '',
          elapsed:fields.elapsed_ms == null ? null : Number(fields.elapsed_ms), fields, raw:s, structured:true,
          ordered:m[1] === 'ble_session', reason:m[3]};
        const status = /(?:^|\b)status(?:\s*[:=]|\s+)\s*(-?\d+)/i.exec(m[3]);
        if (status) e.status=Number(status[1]);
        if (event === 'gatt' && /new state:\s*0\s*\(DISCONNECTED\)/i.test(s)) e.event='disconnected';
        return e;
      }
      m = /^(\d{10,16})\s*[,，]\s*(.*?)\s*(Link-lossOccur|Disconnected|Connected|onError)\s*$/.exec(s);
      if (!m) return null;
      const event = {Connected:'connection_ready',Disconnected:'disconnected','Link-lossOccur':'link_loss',onError:'error'}[m[3]];
      return {kind:'connection',event,source,line,endLine:line,t:Number(m[1]),appConnection:'',elapsed:null,
        fields:{device:m[2].trim()},raw:s,structured:false,ordered:false,reason:'旧版连接记录：' + m[2] + m[3]};
    }
    function tracker(lines, side) {
      const ordered = lines.some(s => /^\s*ble_session\s+\d+\s*,.*\bevent=(start|end)\b/.test(s));
      let epoch=0, serial=0, current=null, closed=false;
      const groups=[];
      const next=(e, evidence) => {
        current={key:side+':'+(++serial),epoch,appConnection:e?.appConnection||'',source:side,
          line:e?.line||1,evidence,frames:0}; groups.push(current);closed=false;
      };
      next(null,'未观察到连接起点');
      return {groups,ordered,get current(){return current;},
        accept(e) {
          if (!e?.kind) return false;
          e.epoch=epoch;
          if (e.event==='process_start') { epoch++; next(e,'应用启动'); e.group=current;e.epoch=epoch;return true; }
          let cut=false;
          if (e.ordered && e.event==='session_start') {
            if (closed || current.appConnection!==e.appConnection || !current.explicitStart) {
              next(e,'有序收包会话开始');current.explicitStart=true;cut=true;
            }
          } else if (e.ordered && e.event==='session_end') {
            // An end marker may be the first observed marker when logging starts mid-connection.
            if (!current.appConnection) current.appConnection=e.appConnection;
            if (current.appConnection===e.appConnection && !closed) {closed=true;cut=true;}
            else e.reason += '；重复结束或旧连接结束，不切断当前收包。';
          } else if (!ordered) {
            if (closing.has(e.event)) {if (!closed) {closed=true;cut=true;}}
            else if (['connect_attempt','link_connected','connection_ready'].includes(e.event)) {
              if (closed || e.appConnection && current.appConnection && e.appConnection!==current.appConnection) {
                next(e,'连接状态记录');cut=true;
              } else if (e.appConnection) current.appConnection=e.appConnection;
            }
          }
          e.group=current;return cut;
        },
        data() {
          // Data after a close but without a new start still cannot join the old stream.
          if (closed) next(null,'断开后再次出现数据；连接起点未记录');
          return current;
        }
      };
    }
    function groupText(g) {
      if(!g)return '连接归属待核对';
      if(g.appConnection==='0')return '应用进程 '+(g.epoch||1)+'（非连接）';
      return (g.appConnection ? '连接 #' + g.appConnection : '连接区间 '+g.key.split(':').at(-1)+'（未记录编号）') + (g.epoch>1?' · 进程段 '+g.epoch:'');
    }
    function decorate(s) {
      const byKey=new Map(s.connectionGroups.map(g=>[g.key,g]));
      const attempts=new Map();
      for(const g of s.connectionGroups)if(g.appConnection){const key=g.epoch+'|'+g.appConnection;attempts.set(key,attempts.has(key)?null:g);}
      for(const e of s.connectionEvents)if(e.appConnection&&attempts.get(e.epoch+'|'+e.appConnection))e.group=attempts.get(e.epoch+'|'+e.appConnection);
      for (const r of s.rows) {
        const g=byKey.get(r.connectionKey); r.connection=g ? groupText(g) : '连接归属待核对';
        r.appConnection=g?.appConnection||'';r.connectionEvidence=g?.evidence||'未关联';
      }
      s.connectionCount=new Set(s.rows.filter(r=>byKey.has(r.connectionKey)).map(r=>r.connectionKey)).size;
      s.unassociatedRanges=new Set(s.rows.filter(r=>!byKey.has(r.connectionKey)).map(r=>r.connectionKey)).size;
    }
    function timeline(data) {
      const events=[], warnings=[], mirrored=new Map(), sourceByName=new Map();
      // Exact event text is the only cross-file identity anchor. IDs and wall time alone are insufficient.
      for (const [side,s] of Object.entries(data).filter(([,s])=>s.connectionEvents)) {
        const seen=new Map();
        for (const e of s.connectionEvents) { const key=e.raw;seen.set(key,(seen.get(key)||0)+1); }
        sourceByName.set(side,seen);
      }
      let linkedDiagnostic=false;
      for (const [side,s] of Object.entries(data).filter(([,s])=>s.connectionEvents)) {
        for (const original of s.connectionEvents) {
          const e={...original,refs:[{source:side,line:original.line,endLine:original.endLine}]};
          e.connection=e.appConnection&&e.appConnection!==e.group?.appConnection?'连接 #'+e.appConnection+' · '+side+' / 进程段 '+e.epoch:groupText(e.group);
          e.connectionKey=e.appConnection&&e.appConnection!==e.group?.appConnection?side+':attempt:'+e.epoch+':'+e.appConnection:e.group?.key;
          const prior=mirrored.get(e.raw);
          if (e.structured && sourceByName.get(side).get(e.raw)===1 && prior && prior.source!==side && sourceByName.get(prior.source).get(e.raw)===1) {
            prior.refs.push(...e.refs); if(side==='connection'||prior.source==='connection')linkedDiagnostic=true;
          } else {events.push(e); if(!prior)mirrored.set(e.raw,e);}
        }
        const firstRows=new Map();for(const r of s.rows)if(!firstRows.has(r.connectionKey))firstRows.set(r.connectionKey,r);
        for (const g of s.connectionGroups) {
          const r=firstRows.get(g.key);
          if (r && (side!=='filtered'||!data.raw)) events.push({kind:'connection',event:'first_packet',source:side,line:r.line,endLine:r.endLine,t:r.t,
            index:r.index,sid:r.sid,cmd:r.cmd,key:r.key,segment:r.segment,cycle:r.cycle,group:g,
            connectionKey:g.key,appConnection:g.appConnection,connection:groupText(g),
            reason:'本文件在此会话中首次观察到 CRC 有效的 AB 报文；日志可能从连接中途开始。'+(side==='filtered'?'这是过滤后记录，不代表原始接收起点。':''),refs:[{source:side,line:r.line,endLine:r.endLine}]});
        }
      }
      if (data.connection && (data.raw||data.filtered) && !linkedDiagnostic) warnings.push('连接诊断文件与报文日志没有相同的连接事件作为关联锚点；各文件独立展示，不按时间或连接编号强行合并。');
      for (const e of events) {
        e.label=labels[e.event]||e.event;
        const explanation={process_start:'应用启动后，连接编号可以从头计数。',connect_attempt:'应用开始一次连接尝试。',
          link_connected:'蓝牙链路建立；还需要等待应用就绪和有效数据。',connection_ready:'应用报告连接已就绪。',
          session_start:'开始新的收包会话，此后报文单独组包和统计序号。',session_end:'当前收包会话结束，残留字节不带入下一连接。',
          disconnected:'应用收到蓝牙断开回调。',link_loss:'应用报告链路丢失；日志本身不说明根本原因。',
          connection_failed:'本次连接尝试失败。',retry_scheduled:'应用安排稍后重试。',retries_exhausted:'本轮自动重试次数已用完。',
          connection_stopped:'应用停止连接或重试。',error:'本次连接过程报告错误。'}[e.event];
        if(explanation)e.reason=explanation+' '+e.reason;
        if(e.status!=null)e.reason+='；状态码 '+e.status+' / 0x'+(e.status>>>0).toString(16).toUpperCase()+'。状态码属于此事件，不代表最初断线原因。';
        if(e.event==='connection_ready')e.reason+='；就绪不等于已恢复收包，请查看后续有效报文。';
        if(e.event==='session_end'&&e.fields?.incomplete_bytes!=null)e.reason+='；结束时残留 '+e.fields.incomplete_bytes+' 字节。';
      }
      // Recovery duration is reported only within one file and process. Never infer causality from a later retry error.
      const recovery=[],recoveredPairs=new Map(),identities=new Map(events.map((e,i)=>[e,i]));
      for (const [side,s] of Object.entries(data).filter(([,s])=>s.connectionEvents)) {
        const lineOf=e=>e.refs.find(r=>r.source===side).line;
        const own=events.filter(e=>e.refs.some(r=>r.source===side)).sort((a,b)=>lineOf(a)-lineOf(b));
        const nextStop=new Array(own.length),stopEvents=new Set(['disconnected','link_loss','session_end','process_start','connection_stopped','connect_attempt']);
        let stopLine=Infinity;
        for(let i=own.length-1;i>=0;i--){nextStop[i]=stopLine;if(stopEvents.has(own[i].event))stopLine=lineOf(own[i]);}
        let lost=null,ready=null;
        for(let i=0;i<own.length;i++){
          const e=own[i];
          if(['process_start','connection_stopped'].includes(e.event)){lost=null;ready=null;}
          if(['disconnected','link_loss'].includes(e.event)&&!lost){lost=e;ready=null;}
          else if(['disconnected','link_loss'].includes(e.event)&&ready){lost=e;ready=null;}
          if(e.event==='connection_ready'&&lost&&!ready){
            if(lost.fields?.device&&e.fields?.device&&lost.fields.device!==e.fields.device){lost=null;ready=null;e.reason+=' 断开与就绪的设备标识不同，不关联恢复时长。';continue;}
            ready=e;
            const monotonic=Number.isFinite(lost.elapsed)&&Number.isFinite(e.elapsed);
            const delta=monotonic?e.elapsed-lost.elapsed:e.t-lost.t;
            const pairKey=identities.get(lost)+'|'+identities.get(e),known=recoveredPairs.get(pairKey);
            const r=known||{source:side,line:lineOf(lost),readyLine:lineOf(e),ms:delta>=0?delta:null,
              clock:monotonic?'单调时钟':'日志时间',dataLine:null};
            if(!known){recovery.push(r);recoveredPairs.set(pairKey,r);}
            e.recovery=r;
            if(!known)e.reason+='；距断线 '+(r.ms==null?'未知（时间戳回退）':r.ms+' ms（'+r.clock+'）')+'。';
            // Notifications may precede the ready callback. Locate the first packet AFTER ready,
            // rather than relying on the one "first_packet" event emitted for the entire session.
            if(r.source===side&&!r.dataLine){
              let lo=0,hi=s.rows.length;
              while(lo<hi){const mid=(lo+hi)>>>1;if(s.rows[mid].line<=lineOf(e))lo=mid+1;else hi=mid;}
              const candidate=s.rows[lo];
              if(candidate&&candidate.line<nextStop[i]&&(!e.appConnection||candidate.appConnection===e.appConnection)){
                r.dataLine=candidate.line;e.reason+=' 本文件随后在 L'+candidate.line+' 观察到有效报文。';
              }
            }
          }
          if(e.event==='first_packet'&&ready?.recovery.source===side&&ready.recovery.dataLine===lineOf(e)){lost=null;ready=null;}
        }
      }
      events.sort((a,b)=>a.t-b.t||a.source.localeCompare(b.source)||a.line-b.line);
      events.forEach((e,i)=>e.id='T'+String(i+1).padStart(5,'0'));
      const count=event=>events.filter(e=>e.event===event).length;
      return {events,warnings,recovery,counts:{events:events.length,attempts:count('connect_attempt'),
        ready:count('connection_ready'),disconnectEvents:count('disconnected')+count('link_loss'),
        retries:count('retry_scheduled'),exhausted:count('retries_exhausted'),errors:count('error')+count('connection_failed')}};
    }
    return {read,tracker,decorate,timeline,labels,groupText};
  }
  if (typeof module!=='undefined'&&module.exports) module.exports=createConnections();
  else {root.ABConnectionsFactory=createConnections;root.ABConnections=createConnections();}
})(typeof globalThis==='undefined'?self:globalThis);
