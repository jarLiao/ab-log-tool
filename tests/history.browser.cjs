const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.AB_PLAYWRIGHT_PATH||'playwright');
const E=require('../dist/engine.js');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts',process.env.AB_HISTORY_REPORT_DIR||'history-check');
fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(out,'browser-profile-'));
const url=process.env.AB_PREVIEW_URL||'http://127.0.0.1:4178';
const report={url,checks:[],errors:[],requests:[]};
const ok=(name,value=true)=>{assert.ok(value,name);report.checks.push(name);};
const base=1800000000000;
const original=[base+','+E.makeFrame(100),(base+25)+','+E.makeFrame(102,[1,3,0x15,0]),'diagnostic',
  (base+1250)+','+E.makeFrame(101),(base+1250)+','+E.makeFrame(103),(base+1240)+','+E.makeFrame(104),(base+1241)+','+E.makeFrame(105)].join('\n');
const file=(name,text=original)=>({name,mimeType:'text/plain',buffer:Buffer.from(text)});
const current=file('synthetic-intervals.txt');
const waitText=(p,selector,text)=>p.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent.includes(text),{selector,text});
const stored=p=>p.evaluate(()=>ABHistory.list());
const dbCounts=p=>p.evaluate(()=>new Promise((resolve,reject)=>{
  const req=indexedDB.open('ab-log-tool-history',1);
  req.onsuccess=()=>{const db=req.result,tx=db.transaction(['tasks','files'],'readonly'),a=tx.objectStore('tasks').count(),b=tx.objectStore('files').count();
    tx.oncomplete=()=>{db.close();resolve([a.result,b.result]);};tx.onabort=()=>reject(tx.error);};req.onerror=()=>reject(req.error);
}));
async function load(p,raw,filtered=null,remember=true){
  await p.locator('#newTask').click();await p.locator('[data-input="'+(raw&&filtered?'pair':raw?'raw':'filtered')+'"]').click();
  await p.locator('#rememberLogs').setChecked(remember);
  if(raw)await p.locator('#rawFile').setInputFiles(raw);if(filtered)await p.locator('#filteredFile').setInputFiles(filtered);
  await p.locator('#analyzeBtn').click();await p.locator('#workspace').waitFor({state:'visible'});
  await waitText(p,'#historySaveStatus',remember?'已保存':'本次仅查看');
}
const setup=p=>{p.setDefaultTimeout(18000);p.on('pageerror',e=>report.errors.push(e.message));p.on('console',e=>{if(e.type()==='error')report.errors.push(e.text());});p.on('request',r=>report.requests.push({url:r.url(),method:r.method()}));};
(async()=>{
  const launch=()=>chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.AB_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',viewport:{width:1440,height:1080},acceptDownloads:true});
  let context=await launch(),page=context.pages()[0];setup(page);
  try{
    await page.goto(url);await page.locator('#historyBtn').click();
    await waitText(page,'#historyEmpty','还没有');ok('Empty archive has an accessible entry point and clear explanation');
    await page.locator('#historyDialog [data-close]').click();
    await page.locator('#demoBtn').click();await waitText(page,'#historySaveStatus','演示数据不保存');
    ok('Demo never creates a history entry',(await stored(page)).length===0);
    await load(page,current);
    ok('Default import saves original log and a task summary',(await stored(page)).length===1&&JSON.stringify(await dbCounts(page))==='[1,1]');
    ok('Detail uses prior valid receive order and keeps command/key',(await page.locator('#fields').innerText()).includes('1225 ms（1.225 s）')&&(await page.locator('#fields').innerText()).includes('0x0066 / L2')&&(await page.locator('#fields').innerText()).includes('命令 / Key'));
    await page.locator('[data-record-index="3"]').click();await waitText(page,'#detailTitle','0x0067');
    ok('Same timestamp is shown as zero, not missing',(await page.locator('#fields').innerText()).includes('0 ms')&&(await page.locator('.packet-timing').innerText()).includes('相同的接收时间戳'));
    await page.locator('#recordNext').click();await waitText(page,'#detailTitle','0x0068');
    ok('Negative interval warns about a timestamp rollback',(await page.locator('#fields').innerText()).includes('-10 ms')&&(await page.locator('.packet-timing').innerText()).includes('时间戳回退'));
    ok('Normal chart point exposes its interval',(await page.locator('[data-record-index="4"]').getAttribute('aria-label')).includes('-10 ms'));
    await page.locator('[data-log-line="3"]').click();await waitText(page,'#detailTitle','原始日志行');
    ok('Diagnostic row clears timing together with packet fields',!(await page.locator('#fields').innerText()).includes('与上包间隔')&&await page.locator('.packet-timing').count()===0);
    await page.locator('#backToEvent').click();await waitText(page,'#fields','1225 ms');
    await page.locator('#exportBtn').click();
    const csvWait=page.waitForEvent('download');await page.locator('#csvBtn').click();await (await csvWait).saveAs(path.join(out,'intervals.csv'));
    const csv=fs.readFileSync(path.join(out,'intervals.csv'),'utf8');
    ok('Downloaded anomaly CSV contains numeric interval and prior source anchor',csv.includes('距上包间隔ms')&&csv.includes('"1225","0x0066","2"'));
    const txtWait=page.waitForEvent('download');await page.locator('#txtBtn').click();await (await txtWait).saveAs(path.join(out,'intervals.txt'));
    ok('Downloaded TXT carries the same interval',fs.readFileSync(path.join(out,'intervals.txt'),'utf8').includes('与上包间隔：1225 ms'));
    await page.locator('#exportDialog [data-close]').click();
    ok('Archive keeps original bytes without rewriting diagnostic lines',await page.evaluate(async()=>{const [e]=await ABHistory.list();return(await(await ABHistory.get(e.id)).files.raw.text());})===original);
    await load(page,current);ok('Reimporting identical named files updates one history entry',(await stored(page)).length===1);
    await page.evaluate(async()=>{const [e]=await ABHistory.list();await ABHistory.touch(e.id,{version:'0.0.0',summary:{raw:{counts:{frames:999,gap:999},segments:1}}});});
    await context.close();context=await launch();page=context.pages()[0];setup(page);await page.goto(url);
    await waitText(page,'#historyCount','1');await page.locator('#historyBtn').click();await page.locator('[data-history-open]').click();
    await waitText(page,'#historySaveStatus','已从本机历史打开');await waitText(page,'#fields','1225 ms');
    ok('Original logs survive a complete browser restart and restore without file picking',(await page.locator('[data-count="frames"] .stat-num').innerText())==='6');
    ok('Restoring reparses with current rules instead of using a stale saved result',(await page.locator('[data-count="gap"] .stat-num').innerText())==='0');
    await load(page,file(current.name,original.replace('diagnostic','different!')));
    ok('Same filename with different content is retained separately',(await stored(page)).length===2);
    const filtered=file('synthetic-filtered.txt',[original.split('\n')[0],original.split('\n')[3],original.split('\n')[4]].join('\n'));
    await load(page,current,filtered);ok('A pair is archived as one task with both files',(await stored(page)).length===3);
    await page.reload();await page.locator('#historyBtn').click();await page.locator('.history-item').filter({hasText:'配对任务'}).locator('[data-history-open]').click();
    await waitText(page,'#historySaveStatus','已从本机历史打开');await page.locator('[data-mode="pair"]').click();
    await waitText(page,'[data-count="matched"] .stat-num','3');
    ok('Restored pair still matches the original frame occurrences');
    await page.locator('[data-mode="filtered"]').click();await waitText(page,'#fileDescription','synthetic-filtered.txt');
    await page.locator('[data-record-index="0"]').click();await waitText(page,'#fields','首包');
    ok('Filtered input has its own previous-packet boundary');
    await load(page,file('view-only.txt'),null,false);ok('Opting out leaves the archive untouched',(await stored(page)).length===3);
    await page.locator('#saveHistoryBtn').click();await waitText(page,'#historySaveStatus','已保存');
    ok('A view-only task can be saved explicitly',(await stored(page)).length===4);
    await page.reload();await page.locator('#newTask').click();ok('Save preference survives refresh',!await page.locator('#rememberLogs').isChecked());
    await page.locator('#importDialog [data-close]').first().click();
    await page.evaluate(()=>{window.testOriginalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='files')throw new DOMException('simulated quota exhaustion','QuotaExceededError');return window.testOriginalPut.apply(this,args);};});
    await page.locator('#newTask').click();await page.locator('[data-input="raw"]').click();await page.locator('#rememberLogs').check();await page.locator('#rawFile').setInputFiles(file('quota-retry.txt'));
    await page.locator('#analyzeBtn').click();await waitText(page,'#historySaveStatus','存储空间不足');
    ok('Storage failure keeps analysis and export available',!await page.locator('#exportBtn').isDisabled()&&(await page.locator('[data-count="frames"] .stat-num').innerText())==='6');
    ok('Failed archive write leaves neither partial metadata nor orphaned files',JSON.stringify(await dbCounts(page))==='[4,4]');
    await page.evaluate(()=>{IDBObjectStore.prototype.put=window.testOriginalPut;delete window.testOriginalPut;});
    await page.locator('#saveHistoryBtn').click();await waitText(page,'#historySaveStatus','已保存');
    ok('Save can be retried after storage recovers',JSON.stringify(await dbCounts(page))==='[5,5]');
    const bounded=await page.evaluate(async()=>{
      const [sample]=await ABHistory.list();const empty={raw:new File(['x'],'generated.txt')};
      let bytesBlocked=false;try{await ABHistory.save({...sample,id:'too-large',bytes:ABHistory.MAX_BYTES+1},empty);}catch{bytesBlocked=true;}
      while((await ABHistory.list()).length<19){const i=(await ABHistory.list()).length;await ABHistory.save({...sample,id:'filler-'+i,bytes:1},empty);}
      const concurrent=await Promise.allSettled(['one','two'].map(id=>ABHistory.save({...sample,id:'last-'+id,bytes:1},empty)));
      return {bytesBlocked,count:(await ABHistory.list()).length,accepted:concurrent.filter(r=>r.status==='fulfilled').length};
    });
    ok('Logical byte limit rejects new history without deleting older tasks',bounded.bytesBlocked);
    ok('Concurrent writes obey the twenty-task limit',bounded.count===20&&bounded.accepted===1&&JSON.stringify(await dbCounts(page))==='[20,20]');
    await page.locator('#historyBtn').click();await page.locator('#historySearch').fill('SYNTHETIC-INTERVALS');
    await page.waitForFunction(()=>document.querySelectorAll('.history-item').length===3);
    ok('History search matches both standalone and paired filenames without case sensitivity');
    for(const width of [1440,1280,375]){
      await page.setViewportSize({width,height:1000});
      ok('History dialog fits viewport '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('#historyDialog').scrollWidth<=document.querySelector('#historyDialog').clientWidth+1));
      await page.screenshot({path:path.join(out,'history-'+width+'.png'),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1080});
    await page.locator('[data-history-delete]').first().click();await page.locator('#cancelHistoryDelete').click();
    ok('Cancel deletion preserves both metadata and source blobs',(await stored(page)).length===20);
    await page.locator('[data-history-delete]').first().click();await page.locator('#confirmHistoryDelete').click();await waitText(page,'#historyMessage','已删除');
    ok('Confirmed deletion removes the selected task and its saved files',JSON.stringify(await dbCounts(page))==='[19,19]');
    await page.locator('#clearHistoryBtn').click();await page.locator('#cancelHistoryDelete').click();ok('Clear-all requires a deliberate confirmation',(await stored(page)).length===19);
    await page.locator('#clearHistoryBtn').click();await page.locator('#confirmHistoryDelete').click();await waitText(page,'#historyMessage','已清空');
    ok('Clear-all removes only this tool archive and keeps the current analysis',JSON.stringify(await dbCounts(page))==='[0,0]'&&!await page.locator('#exportBtn').isDisabled());
    await page.locator('#historyDialog [data-close]').click();
    await page.locator('#newTask').click();await page.locator('#rawFile').setInputFiles(file('cancelled-large.txt',original.repeat(90000)));await page.locator('#analyzeBtn').click();
    await page.locator('#progressDialog').waitFor({state:'visible'});await page.locator('#cancelAnalysis').click();await page.locator('#welcome').waitFor({state:'visible'});
    ok('Cancelled analysis is not saved',(await stored(page)).length===0);
    const blocked=await context.newPage();setup(blocked);
    await blocked.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('simulated unavailable storage','SecurityError');}}));
    await blocked.goto(url);await blocked.locator('#newTask').click();await blocked.locator('#rawFile').setInputFiles(current);await blocked.locator('#analyzeBtn').click();
    await waitText(blocked,'#historySaveStatus','本次未保存');
    ok('Unavailable IndexedDB cannot block analysis',!await blocked.locator('#exportBtn').isDisabled());await blocked.close();
    await load(page,file('<b>literal-title</b>.txt'));
    await page.locator('#historyBtn').click();await page.locator('#historySearch').fill('literal-title');
    ok('History filenames remain plain text',await page.locator('.history-info strong b').count()===0&&(await page.locator('.history-info strong').innerText()).includes('<b>'));
    await page.locator('[data-history-open]').click();await waitText(page,'#historySaveStatus','已从本机历史打开');
    ok('Quoted history identifiers can restore their original file',(await page.locator('#fileDescription').innerText()).includes('<b>literal-title</b>.txt'));
    const large=path.join(root,'artifacts/generated-50MiB.txt');
    if(fs.existsSync(large)&&!process.env.AB_SKIP_HISTORY_LARGE){
      const savedAt=Date.now();await load(page,large);report.largeSaveMs=Date.now()-savedAt;
      await context.close();context=await launch();page=context.pages()[0];setup(page);await page.goto(url);
      await page.locator('#historyBtn').click();await page.locator('#historySearch').fill('generated-50MiB');
      const restoredAt=Date.now();await page.locator('[data-history-open]').click();await waitText(page,'#historySaveStatus','已从本机历史打开');report.largeRestoreMs=Date.now()-restoredAt;
      ok('A 50 MiB archived file survives browser restart and reparses all frames',(await page.locator('[data-count="frames"] .stat-num').innerText())==='235,107');
      await page.locator('[data-log-action="end"]').click();await page.locator('[data-log-line="235107"]').click();
      await waitText(page,'#recordPosition','235,107 / 235,107');
      ok('Restored large log reaches its actual final packet with a receive interval',(await page.locator('#fields').innerText()).includes('与上包间隔')&&(await page.locator('#fields').innerText()).includes('L235106'));
    }
    await page.locator('#historyBtn').click();await page.locator('#clearHistoryBtn').click();await page.locator('#confirmHistoryDelete').click();await waitText(page,'#historyMessage','已清空');
    ok('No unexpected browser errors',report.errors.length===0);
    ok('No log uploads or third-party requests',report.requests.every(r=>r.method==='GET'&&(r.url.startsWith('blob:')||new URL(r.url).origin===new URL(url).origin)));
    report.success=true;console.log(JSON.stringify({passed:report.checks.length,url,largeSaveMs:report.largeSaveMs,largeRestoreMs:report.largeRestoreMs},null,2));
  }catch(error){report.failure=error.stack;await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});throw error;}
  finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await context.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
