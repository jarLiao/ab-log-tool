const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.AB_PLAYWRIGHT_PATH||'playwright');
const E=require('../dist/engine.js');
const url=process.env.AB_PREVIEW_URL||'http://127.0.0.1:4178';
const out=path.resolve(__dirname,'../artifacts',process.env.AB_JUMP_REPORT_DIR||'jump-check');
fs.mkdirSync(out,{recursive:true});
const report={url,checks:[],errors:[],requests:[]};
const ok=(name,value=true)=>{assert.ok(value,name);report.checks.push(name);};
// Synthetic sequence pattern from the screenshot, not the user's source log.
const runs=[[50752,24277],[47995,330],[47996,2220]],lines=[];
runs.forEach(([start,count],version)=>{
  for(let i=0;i<count;i++)lines.push((1800000000000+lines.length)+','+E.makeFrame((start+i)&65535,[0x7b,3,0x11,version]).toLowerCase());
});
const file={name:'synthetic-sequence-jumps.txt',mimeType:'text/plain',buffer:Buffer.from(lines.join('\n'))};
const expectSid=(page,sid)=>page.waitForFunction(sid=>document.querySelector('#detailTitle .seq-primary')?.textContent===sid,sid);
const count=async(page,key)=>Number((await page.locator('[data-count="'+key+'"] .stat-num').innerText()).replaceAll(',',''));
async function load(page,mode='raw'){
  await page.locator('#newTask').click();await page.locator('[data-input="'+mode+'"]').click();
  await page.locator(mode==='raw'?'#rawFile':'#filteredFile').setInputFiles(file);
  await page.locator('#analyzeBtn').click();await page.locator('#workspace').waitFor({state:'visible'});
  await expectSid(page,'0x2514 → 0xBB7B');
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.AB_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:1440,height:1080},acceptDownloads:true});
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',e=>{if(e.type()==='error')report.errors.push(e.text());});
  page.on('request',r=>report.requests.push({url:r.url(),method:r.method()}));
  try{
    await page.goto(url);await load(page);
    ok('Version matches the released package',(await page.locator('.version').innerText()).includes('v'+require('../package.json').version));
    ok('Synthetic pattern keeps 26827 frames and two boundaries',await count(page,'frames')===26827&&await count(page,'rollback')===2);
    ok('Segment missing IDs, late arrivals and collisions remain zero',await count(page,'gap')===0&&await count(page,'reorder')===0&&await count(page,'collision')===0);
    ok('Boundary count is explicitly different from a loss count',(await page.locator('[data-count="rollback"]').innerText()).includes('处边界，非丢包数量')&&(await page.locator('#qualityNote').innerText()).includes('3 个分析段'));
    ok('List, filter and legend use neutral jump labels',(await page.locator('#eventRows').innerText()).includes('序号跳变待核对')&&(await page.locator('#kindFilter option[value="rollback"]').innerText())==='序号跳变待核对'&&(await page.locator('.chart-legend').innerText()).includes('跳变待核对'));
    ok('Increasing numbers are labeled as an observation',(await page.locator('#fields').innerText()).includes('数值增大 38503')&&(await page.locator('#fields').innerText()).includes('方向待核对'));
    const summary=await page.locator('#detailSummary').innerText();
    ok('Two candidate distances are shown without claiming a backward move',summary.includes('向前跨越 38503')&&summary.includes('向后跨越 27033')&&summary.includes('不能确认方向')&&!summary.includes('回退到'));
    await page.waitForFunction(()=>document.querySelectorAll('.seq-byte-mark').length===4);
    ok('Both actual little-endian source anchors stay exact',JSON.stringify(await page.locator('.seq-byte-mark').allTextContents())===JSON.stringify(['7b','bb','14','25']));
    ok('The uncertain chart boundary is separate from the packet line',((await page.locator('#chart > path').getAttribute('d')).match(/M/g)||[]).length===2&&(await page.locator('#chart').innerHTML()).includes('序号跳变 · 待核对分段'));
    for(const width of [1440,1280,375]){
      await page.setViewportSize({width,height:1080});
      ok('New explanatory fields fit viewport '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:path.join(out,'jump-'+width+'.png'),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1080});
    await page.locator('#eventRows tr').nth(1).click();await expectSid(page,'0xBCC4 → 0xBB7C');
    ok('Decreasing numbers show observed change with an unknown cause',(await page.locator('#fields').innerText()).includes('数值减小 328')&&(await page.locator('#fields').innerText()).includes('原因待核对')&&(await page.locator('#detailSummary').innerText()).includes('不能据此确认设备重启'));
    await page.locator('#sequenceBase').selectOption('dec');await expectSid(page,'48324 → 47996');
    ok('Decimal display retains both real boundary endpoints');
    await page.locator('#sequenceBase').selectOption('hex');
    await page.locator('[data-record-index="24608"]').click();await expectSid(page,'0xBB7D');
    ok('Selecting a normal packet clears boundary-only explanation',!(await page.locator('#fields').innerText()).includes('观测到的数值变化')&&!(await page.locator('#fields').innerText()).includes('判定状态')&&(await page.locator('#fields').innerText()).includes('0x7B / 0x11'));
    await page.locator('#backToEvent').click();await expectSid(page,'0xBCC4 → 0xBB7C');
    ok('Returning to the anomaly restores its own observed change',(await page.locator('#fields').innerText()).includes('数值减小 328'));
    await page.locator('#eventRows tr').first().click();await expectSid(page,'0x2514 → 0xBB7B');
    await page.locator('#exportBtn').click();
    await page.locator('#exportRange').selectOption('filtered');
    const csvWait=page.waitForEvent('download');await page.locator('#csvBtn').click();await (await csvWait).saveAs(path.join(out,'jumps.csv'));
    const csv=fs.readFileSync(path.join(out,'jumps.csv'),'utf8');
    const rows=csv.trim().replace(/^\uFEFF/,'').split('\r\n').map(line=>line.slice(1,-1).split('\",\"'));
    const header=rows.shift(),cell=(row,name)=>row[header.indexOf(name)];
    ok('CSV exports exactly two boundaries and neutral column names',rows.length===2&&header.includes('前一报文序号HEX')&&!header.includes('回退幅度')&&!header.includes('回退前序号'));
    ok('CSV keeps observed signed change separate from candidate distance',cell(rows[0],'序号数值变化')==='38503'&&cell(rows[0],'候选向后跨度')==='27033'&&cell(rows[0],'判定提示')==='方向待核对'&&cell(rows[1],'序号数值变化')==='-328');
    const txtWait=page.waitForEvent('download');await page.locator('#txtBtn').click();await (await txtWait).saveAs(path.join(out,'jumps.txt'));
    const txt=fs.readFileSync(path.join(out,'jumps.txt'),'utf8');
    ok('TXT uses the same neutral wording and actual source snippets',txt.includes('序号跳变待核对')&&txt.includes('数值增大 38503')&&txt.includes('段间待核对')&&txt.includes(lines[24277])&&txt.includes(lines[24276])&&!txt.includes('回退到'));
    await page.locator('#exportDialog [data-close]').click();
    await page.locator('[data-stat="rollback"]').click();
    await page.waitForFunction(()=>document.querySelector('#kindFilter').value==='rollback');
    ok('The renamed card still locates both reviewable boundaries',await page.locator('#eventRows tr').count()===2);
    await load(page,'filtered');
    ok('Independent filtered analysis uses the same uncertainty wording',(await page.locator('#fields').innerText()).includes('方向待核对')&&await count(page,'rollback')===2);
    await page.locator('#aboutBtn').click();
    ok('Rules explain that nearest-cycle assignment is only a candidate',(await page.locator('#aboutDialog').innerText()).includes('不能由此确定实际前进或回退'));
    ok('No page runtime errors',report.errors.length===0);
    ok('Log data stays local',report.requests.every(r=>r.method==='GET'&&(r.url.startsWith('blob:')||new URL(r.url).origin===new URL(url).origin)));
    report.success=true;report.browser=await browser.version();
    console.log(JSON.stringify({passed:report.checks.length,url,browser:report.browser},null,2));
  }catch(error){report.failure=error.stack;await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});throw error;}
  finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
