const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.AB_PLAYWRIGHT_PATH||'playwright');
const E=require('../dist/engine.js'),root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts','connection-markers-check');
fs.mkdirSync(out,{recursive:true});
const url=process.env.AB_PREVIEW_URL||'http://127.0.0.1:4178';
const base=Date.parse('2026-09-16T10:00:00+08:00');
const packet=(sid,t)=>`${t},${E.makeFrame(sid)}`;
const raw=[...Array.from({length:60},(_,i)=>packet(i,base+i*1000)),`${base+60000},Watch Link-lossOccur`,
  `${base+60006},Watch Link-lossOccur`,`${base+86400000},Watch Connected`,
  ...Array.from({length:140},(_,i)=>packet(60+i,base+86400100+i*1000)),
  `${base+86600000},Watch Link-lossOccur`,`${base+86600013},Watch Link-lossOccur`,`${base+172800000},Watch Disconnected`].join('\n');
const report={checks:[],errors:[]};
const ok=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
const waitText=(p,s,text)=>p.waitForFunction(({s,text})=>document.querySelector(s)?.textContent.includes(text),{s,text});
async function load(page,text,name){
  await page.locator('#newTask').click();await page.locator('[data-input="raw"]').click();
  await page.locator('#rememberLogs').uncheck();
  await page.locator('#rawFile').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(text)});
  await page.locator('#analyzeBtn').click();await waitText(page,'#sourceNote',name);
  await page.locator('#fullBtn').click();await page.waitForFunction(()=>document.querySelector('#fullBtn').classList.contains('active'));
}
async function bounds(page){
  return page.evaluate(()=>{
    const svg=document.querySelector('#chart'),w=svg.viewBox.baseVal.width;
    return document.documentElement.scrollWidth<=innerWidth+1&&[...svg.querySelectorAll('.chart-boundary text,.chart-connection text')]
      .every(t=>{const b=t.getBBox();return b.x>=0&&b.x+b.width<=w;});
  });
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.AB_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
  page.on('pageerror',e=>report.errors.push(e.message));page.setDefaultTimeout(12000);
  try{
    await page.goto(url);await load(page,raw,'synthetic-reconnect.txt');
    const parsed=E.parse(raw),groups=E.chart({raw:parsed},'raw',{}).connectionMarkers;
    ok('Switch and tail are both visible without creating a third packet segment',await page.locator('.chart-boundary').count()===1&&await page.locator('.chart-connection').count()===1&&await page.locator('.connection-card').count()===2);
    ok('Boundary uses the interval-switch name and tail explains no later packets',(await page.locator('#chart').textContent()).includes('连接区间切换')&&(await page.locator('.is-tail').innerText()).includes('本文件此后无有效报文'));
    ok('Loss, ready and actual packet times are visible with dates',(await page.locator('#chartConnectionCards').innerText()).includes('2026-09-16 10:01:00.000')&&(await page.locator('#chartConnectionCards').innerText()).includes('2026-09-17 10:00:00.100'));
    ok('Repeated callbacks retain distinct source links',await page.locator('.connection-entry').count()===7);
    ok('Chart tooltip includes dates and original source lines',(await page.locator('.chart-boundary title').textContent()).includes('L61')&&(await page.locator('.chart-connection title').textContent()).includes('本文件此后无有效报文'));
    await page.locator('.chart-boundary').click();await waitText(page,'.packet-timing','跨连接');
    ok('Boundary click still selects the real first packet',(await page.locator('#detailSummary').innerText()).includes('CRC16'));
    for(const group of groups)for(const event of group.events){
      await page.locator(`[data-connection-line="${event.line}"]`).click();
      await page.waitForFunction(line=>document.querySelector('.log-code [aria-selected="true"]')?.dataset.logLine===String(line)||document.querySelector('.log-jump')?.value===String(line),event.line);
    }
    ok('All event and resumed-packet buttons resolve their exact original line',true);
    ok('Source links move the viewport and keyboard focus to the selected detail',await page.locator('#detailTitle').evaluate(el=>el===document.activeElement&&el.getBoundingClientRect().top>=0&&el.getBoundingClientRect().top<innerHeight));
    await page.locator('.chart-connection').focus();await page.keyboard.press('Enter');await waitText(page,'#detailTitle','连接丢失');
    ok('Terminal marker supports keyboard activation and retains focus',await page.locator('.chart-connection').evaluate(el=>el===document.activeElement));
    await page.locator('#zoomIn').click();await page.waitForFunction(()=>!document.querySelector('.connection-card.is-tail'));
    ok('Zooming into the middle removes the offscreen end marker',await page.locator('.chart-connection').count()===0);
    await page.locator('#fullBtn').click();await page.locator('.connection-card.is-tail').waitFor();
    ok('Returning to the full log restores its terminal event',await page.locator('.chart-connection').count()===1);
    for(const size of [{width:375,height:812},{width:812,height:375},{width:1920,height:1080}]){
      await page.setViewportSize(size);await page.waitForTimeout(180);
      ok(`Connection cards and endpoint labels fit ${size.width}x${size.height}`,await bounds(page));
      await page.locator('#chartPanel').screenshot({path:path.join(out,`chart-${size.width}.png`)});
    }
    await page.locator('#chartTimeline').click();await waitText(page,'#resultTitle','连接事件');
    ok('Complete timeline remains reachable and retains all original events',(await page.locator('#connectionCount').innerText())==='8');
    await load(page,[packet(10,base),`${base+10},Watch Disconnected`,`${base+20},Watch Connected`].join('\n'),'ready-without-data.txt');
    ok('Ready after the last packet does not claim resumed reception',(await page.locator('.is-tail').innerText()).includes('末尾连接已就绪')&&!(await page.locator('#chartConnectionCards').innerText()).includes('重新收到报文'));
    const dense=Array.from({length:12},(_,i)=>[`${base+i*100},Watch Connected`,packet(i,base+i*100+1),`${base+i*100+2},Watch Disconnected`].join('\n')).join('\n');
    await load(page,dense,'dense-reconnects.txt');
    ok('Dense connection records retain the terminal card and disclose omitted cards',await page.locator('.connection-card').count()===6&&await page.locator('.is-tail').count()===1&&await page.locator('#chartConnectionMore').isVisible());
    await page.setViewportSize({width:375,height:812});await page.waitForTimeout(180);
    ok('Dense labels stay within the plot on a small screen',await bounds(page));
    ok('Dense boundaries never suppress the terminal label',await page.locator('.chart-connection text').filter({hasText:'末尾连接断开'}).isVisible());
    await page.locator('#chartPanel').screenshot({path:path.join(out,'dense-mobile.png')});
    if(process.env.AB_CONNECTION_LOG){
      const text=fs.readFileSync(process.env.AB_CONNECTION_LOG,'utf8'),s=E.parse(text),chart=E.chart({raw:s},'raw',{});
      assert.equal(s.counts.frames,19981);assert.equal(s.counts.gap,3);assert.equal(s.segments,2);
      assert.equal(chart.connectionMarkers.length,2);assert.deepEqual(chart.connectionMarkers.map(m=>m.events.map(e=>e.line)),[[10526,10528,10530,10532],[40588,40590,40592,40594]]);
      report.realLog={counts:s.counts,segments:s.segments,markers:chart.connectionMarkers};
      await page.setViewportSize({width:1920,height:1080});await load(page,text,path.basename(process.env.AB_CONNECTION_LOG));
      ok('User log preserves 19981 packets and 3 missing IDs while showing both connection positions',await page.locator('.connection-card').count()===2&&(await page.locator('[data-count="gap"] .stat-num').innerText())==='3');
      await page.locator('[data-connection-line="40588"]').click();await waitText(page,'#detailTitle','连接丢失');
      ok('Real terminal disconnect points to L40588 and the original date',(await page.locator('.is-tail').innerText()).includes('2026-09-17 22:01:25.768'));
      await page.locator('#chartPanel').screenshot({path:path.join(out,'real-log-chart.png')});
      await page.setViewportSize({width:375,height:812});await page.waitForTimeout(180);
      ok('Real log terminal label is not clipped on mobile',await bounds(page));
      await page.locator('#chartPanel').screenshot({path:path.join(out,'real-log-mobile.png')});
    }
    await page.goto(pathToFileURL(path.join(root,'dist','index.html')).href);await load(page,raw,'offline-reconnect.txt');
    ok('Direct local HTML opening includes terminal annotations',await page.locator('.is-tail').count()===1);
    ok('No browser runtime errors',report.errors.length===0);report.success=true;
  }finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({success:report.success,checks:report.checks,errors:report.errors},null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
