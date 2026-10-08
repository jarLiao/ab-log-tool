const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.AB_PLAYWRIGHT_PATH || 'playwright');
const E = require('../dist/engine.js');

const url = process.env.AB_PREVIEW_URL || 'http://127.0.0.1:4178';
const output = path.resolve(__dirname, '../artifacts');
fs.mkdirSync(output, {recursive: true});
const base = 1800000000000;
const rows = [
  [100, [0xfb, 2, 0x02, 0xaa, 2, 0x03, 0xbb]],
  [101, [0x01, 2, 0x01, 0xcc]],
  [102, [0xfb, 2, 0x02, 0xdd]],
  [103, [0xfb, 2, 0x03, 0xee]]
];
const line = ([sid, body], i) => (base + i * 100) + ',' + E.makeFrame(sid, body);
const raw = {name: 'packet-query-abBle.txt', mimeType: 'text/plain', buffer: Buffer.from(rows.map(line).join('\n'))};
const gapRaw = {name: 'packet-query-gap-abBle.txt', mimeType: 'text/plain', buffer: Buffer.from([...rows, [105, [0xfb, 2, 0x02, 0xff]]].map(line).join('\n'))};
const filtered = {name: 'packet-query-abFilter.txt', mimeType: 'text/plain', buffer: Buffer.from([line(rows[0], 0), line(rows[2], 2)].join('\n'))};

async function importLogs(page, kind, files) {
  await page.locator('#newTask').click();
  await page.locator('[data-input="' + kind + '"]').click();
  if (files.raw) await page.locator('#rawFile').setInputFiles(files.raw);
  if (files.filtered) await page.locator('#filteredFile').setInputFiles(files.filtered);
  await page.locator('#analyzeBtn').click();
  await page.locator('#workspace').waitFor({state: 'visible', timeout: 30000});
  if (kind === 'pair') await page.locator('[data-mode="pair"]').click();
}

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.AB_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page = await browser.newPage({viewport: {width: 1360, height: 950}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await importLogs(page, 'raw', {raw});
    await page.locator('#packetPanel').waitFor({state: 'visible'});
    await page.locator('#packetCommand').fill('FB');
    await page.locator('#packetKey').fill('02');
    await page.waitForFunction(() => document.querySelector('#packetCount').textContent === '2 条有效报文');
    assert.match(await page.locator('#packetVerdict').innerText(), /完整原始日志没有最终缺号/);
    assert.match(await page.locator('#packetRows').innerText(), /中间有 1 条其他有效报文/);
    assert.equal(await page.locator('#packetRows tr').count(), 2);
    assert.equal(await page.locator('#chart .chart-packet-match').count(), 2);
    await page.locator('#packetPanel').screenshot({path: path.join(output, 'packet-query-desktop-1360.png')});
    await page.locator('#packetRows tr').last().click();
    await page.waitForFunction(() => document.querySelector('#detailTitle .seq-primary')?.textContent === '0x0066');
    assert.match(await page.locator('#fields').innerText(), /L3/);
    await page.locator('#packetKey').fill('03');
    await page.waitForFunction(() => document.querySelector('#packetCount').textContent === '2 条有效报文');
    assert.match(await page.locator('#packetRows').innerText(), /0x0064/);
    assert.match(await page.locator('#packetRows').innerText(), /0x0067/);
    await page.locator('#packetCommand').fill('FZ');
    await page.waitForFunction(() => document.querySelector('#packetCount').textContent === '输入有误');
    assert.match(await page.locator('#packetVerdict').innerText(), /两位十六进制/);
    assert.equal(await page.locator('#packetResults').isVisible(), false);
    await page.locator('#packetCommand').fill('FB');
    await page.locator('#packetKey').fill('02');
    await page.waitForFunction(() => document.querySelector('#packetCount').textContent === '2 条有效报文');
    await page.setViewportSize({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390px viewport must not overflow');
    await page.locator('#packetPanel').screenshot({path: path.join(output, 'packet-query-mobile-390.png')});

    await importLogs(page, 'pair', {raw, filtered});
    await page.locator('#packetCommand').fill('FB');
    await page.locator('#packetKey').fill('02');
    await page.waitForFunction(() => document.querySelector('#packetCount').textContent === '2 条有效报文');
    await page.locator('#chartSide').selectOption('filtered');
    await page.waitForFunction(() => document.querySelector('#packetSource').textContent.includes('过滤之后') && document.querySelector('#packetCount').textContent === '2 条有效报文');
    assert.match(await page.locator('#packetVerdict').innerText(), /完整原始日志没有最终缺号/);
    assert.equal(await page.locator('#chart .chart-packet-match').count(), 2);

    await importLogs(page, 'raw', {raw: gapRaw});
    await page.locator('#packetCommand').fill('FB');
    await page.locator('#packetKey').fill('02');
    await page.waitForFunction(() => document.querySelector('#packetCount').textContent === '3 条有效报文');
    assert.match(await page.locator('#packetVerdict').innerText(), /最终缺 1 个序号/);
    assert.match(await page.locator('#packetVerdict').innerText(), /Command\/Key 未知/);

    await importLogs(page, 'filtered', {filtered});
    await page.locator('#packetCommand').fill('FB');
    await page.locator('#packetKey').fill('02');
    await page.waitForFunction(() => document.querySelector('#packetCount').textContent === '2 条有效报文');
    assert.match(await page.locator('#packetVerdict').innerText(), /只有过滤日志/);
    assert.ok(await page.locator('#packetVerdict').evaluate(el => el.classList.contains('unknown')));
    assert.deepEqual(errors, []);
    process.stdout.write('报文查询 UI：Command/Key、多 Key、全量连续/缺号、配对、图表高亮、原文、错误态、390px、过滤限制均通过。\n');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
