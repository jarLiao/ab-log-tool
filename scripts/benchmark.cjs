const fs = require('node:fs');
const E = require('../dist/engine.js');
const file = process.argv[2];
if (!file) throw new Error('请提供规模验收日志路径。');
const started = performance.now();
const s = E.parse(fs.readFileSync(file, 'utf8'), '规模验收.txt', 'raw');
console.log(JSON.stringify({
  runtime: process.version,
  fileBytes: fs.statSync(file).size,
  frames: s.counts.frames,
  finalMissing: s.counts.gap,
  duplicate: s.counts.duplicate,
  wraps: s.wraps,
  elapsedMs: Math.round(performance.now() - started),
  peakProcessRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
  note: '独立 Node 解析进程的操作系统峰值常驻内存，不是浏览器总内存。'
}, null, 2));
