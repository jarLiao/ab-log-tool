const assert = require('node:assert/strict');
const {chromium} = require(process.env.AB_PLAYWRIGHT_PATH || 'playwright');
const E = require('../dist/engine.js');

const url = process.env.AB_PREVIEW_URL || 'http://127.0.0.1:4178';
const base = 1800000000000;
const lines = Array.from({length: 1100}, (_, index) => {
  // The two hits live beyond the initial virtualized log window. The first
  // timestamp is uniquely searchable by its last four digits.
  const timestamp = index === 699 ? base + 12345 : index === 899 ? base + 19876 : base + index;
  const body = index === 699 || index === 899
    ? [0xfb, 5, 0x02, 0xde, 0xad, 0xbe, 0xef]
    : [0x7b, 3, 0x11, index & 255];
  return timestamp + ',' + E.makeFrame(1000 + index, body);
});
assert.deepEqual(lines.flatMap((line, index) => line.includes('2345') ? [index + 1] : []), [700]);
assert.deepEqual(lines.flatMap((line, index) => line.toLowerCase().includes('deadbeef') ? [index + 1] : []), [700, 900]);
const file = {name: 'raw-text-search.txt', mimeType: 'text/plain', buffer: Buffer.from(lines.join('\n'))};
const filteredFile = {name: 'filtered-text-search.txt', mimeType: 'text/plain', buffer: Buffer.from(lines[899])};

async function load(page, kind, inputFiles) {
  await page.locator('#newTask').click();
  await page.locator('[data-input="' + kind + '"]').click();
  if (inputFiles.raw) await page.locator('#rawFile').setInputFiles(inputFiles.raw);
  if (inputFiles.filtered) await page.locator('#filteredFile').setInputFiles(inputFiles.filtered);
  await page.locator('#analyzeBtn').click();
  await page.locator('#workspace').waitFor({state: 'visible', timeout: 30000});
  await page.locator('.log-window .code-line').first().waitFor();
}

async function expectLocated(page, line) {
  await page.waitForFunction(line => document.querySelector('#fields')?.textContent.includes('L' + line), line);
  await page.locator('.raw-section [data-log-line="' + line + '"]').waitFor({state: 'visible'});
  assert.match(await page.locator('#detailTitle').innerText(), /报文记录/);
}

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.AB_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page = await browser.newPage({viewport: {width: 1360, height: 900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await load(page, 'raw', {raw: file});

    const search = page.locator('#rawSearch');
    await page.locator('#rawSearchScope').selectOption('timestamp');
    await search.fill('2345');
    await search.press('Enter');
    await page.waitForFunction(() => document.querySelector('#rawSearchStatus')?.textContent.includes('1'));
    await expectLocated(page, 700);
    assert.match(await page.locator('#rawSearchStatus').innerText(), /1/);
    assert.equal(await page.locator('.raw-search-hit').first().innerText(), '2345', '命中的时间戳片段应在原文中高亮');

    await search.fill('dEaDbEeF');
    await page.locator('#rawSearchSubmit').click();
    await page.waitForFunction(() => /0|无|未找到/.test(document.querySelector('#rawSearchStatus')?.textContent || ''));
    assert.equal(await page.locator('#rawSearchNext').isDisabled(), true, '时间戳范围不应误匹配报文正文');

    await page.locator('#rawSearchScope').selectOption('all');
    await page.locator('#rawSearchSubmit').click();
    await page.waitForFunction(() => document.querySelector('#rawSearchStatus')?.textContent.includes('2'));
    await expectLocated(page, 700);
    assert.equal((await page.locator('.raw-search-hit').first().innerText()).toLowerCase(), 'deadbeef', '命中的正文片段应在原文中高亮');
    await page.locator('#rawSearchNext').click();
    await expectLocated(page, 900);
    await page.locator('#rawSearchPrev').click();
    await expectLocated(page, 700);

    await search.fill('not-present-in-log');
    await page.locator('#rawSearchSubmit').click();
    await page.waitForFunction(() => /0|无|未找到/.test(document.querySelector('#rawSearchStatus')?.textContent || ''));
    assert.equal(await page.locator('#rawSearchNext').isDisabled(), true);
    assert.equal(await page.locator('#rawSearchPrev').isDisabled(), true);

    await load(page, 'pair', {raw: file, filtered: filteredFile});
    await search.fill('dEaDbEeF');
    await page.locator('#rawSearchSubmit').click();
    await page.waitForFunction(() => document.querySelector('#rawSearchStatus')?.textContent.includes('2'));
    await page.locator('#rawSearchSource').selectOption('filtered');
    assert.equal(await page.locator('#rawSearchNext').isDisabled(), true, '切换日志文件后不可继续浏览上一个文件的命中');
    await page.locator('#rawSearchSubmit').click();
    await page.waitForFunction(() => document.querySelector('#rawSearchStatus')?.textContent.includes('1'));
    await expectLocated(page, 1);
    assert.match(await page.locator('#codeSections').innerText(), /filtered-text-search\.txt/);

    await load(page, 'raw', {raw: {name: 'new-task.txt', mimeType: 'text/plain', buffer: Buffer.from(lines[0])}});
    assert.equal(await search.inputValue(), '', '新任务应清除旧查询字词');
    assert.equal(await page.locator('#rawSearchSource').inputValue(), 'raw', '新任务应重置日志来源');
    assert.equal(await page.locator('#rawSearchScope').inputValue(), 'all', '新任务应恢复全文范围');
    await search.fill('deadbeef');
    await page.locator('#rawSearchSubmit').click();
    await page.waitForFunction(() => /0|无|未找到/.test(document.querySelector('#rawSearchStatus')?.textContent || ''));

    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await search.isVisible(), true);
    assert.deepEqual(errors, []);
    process.stdout.write('原文全文查询：时间戳末四位、帧内数据片段、虚拟窗口外定位、前后结果、空结果、来源切换、新任务重置及手机布局均通过。\n');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
