/**
 * 给 install.ps1 补 UTF-8 BOM，并验前 3 字节是 239,187,191。
 *
 * 为什么单独一个脚本：install.ps1 必须**以 UTF-8 with BOM 保存**，
 * 否则 Windows PowerShell 5.1 会按 GBK 读中文，整个脚本的提示都是乱码。
 * 用 Node 的 fs 写、再用 Node 验前 3 字节，这是交接文档里钉死的做法
 * （别用 `Set-Content` / `.NET` 静态调用改中文文件）。
 *
 * 用法：node tools/fix-ps1-bom.mjs [文件路径...]
 * 默认处理 install.ps1。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['install.ps1'];

for (const p of targets) {
  let bytes;
  try {
    bytes = readFileSync(p);
  } catch (err) {
    console.log(`X 读不到 ${p}：${err.message}`);
    process.exitCode = 1;
    continue;
  }

  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // 写入途中被换成 U+FFFD 的字符：Die 那一行的红叉改成 ASCII，其余报出来人工看。
  const bad = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('\uFFFD')) bad.push(i + 1);
  });
  text = text.replace(/Write-Host "\uFFFD+ \$msg"/g, 'Write-Host "X $msg"');

  const remaining = (text.match(/\uFFFD/g) || []).length;
  writeFileSync(p, `\uFEFF${text}`, 'utf8');

  const out = readFileSync(p);
  const bomOk = out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf;
  console.log(`${bomOk ? 'OK' : 'FAIL'} ${p}：前 3 字节 ${out[0]},${out[1]},${out[2]}${bomOk ? '（BOM 正确）' : '（BOM 缺失）'}`);
  if (bad.length) {
    console.log(`  ! 这些行原本含替换字符：${bad.join(', ')}；处理后还剩 ${remaining} 个`);
    if (remaining) process.exitCode = 1;
  }
}
