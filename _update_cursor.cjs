const fs = require('fs');
let d = fs.readFileSync('docs/plans/development-progress.md', 'utf8');
// 全局阻塞行（当前文档实际内容）
const oldBlock = '剩余 prod 5 / full 8 moderate 依赖公告未扩修；T33 扩展维护、T34/T36 门控保留；真实服务商、WinCred、部署和发布不由本轮代码验收替代。';
if (!d.includes(oldBlock)) throw new Error('global block text not found');
d = d.replace(oldBlock, '依赖公告已清零（生产/全量 audit 均 0，逐项证据见 docs/analysis/2026-11-01-t33-dependency-maintenance.md，本轮用户授权扩修 T33）；T34/T36 门控保留；真实服务商、WinCred、部署和发布不由本轮代码验收替代。');
// T33 保留门控行（2026-10-17 表中的 awaiting_human 行）
const gateMatches = [...d.matchAll(/\| T33 [^|]*\|[^|]*\|/g)];
let gateRow = gateMatches.find(m => m[0].includes('awaiting_human'));
if (!gateRow) gateRow = gateMatches.find(m => m[0].includes('T33 扩展依赖维护'));
if (!gateRow) throw new Error('T33 gate row not found; rows=' + gateMatches.map(m=>m[0].slice(0,60)).join(' ;; '));
const gateNew = '| T33 扩展依赖维护 | 已完成（2026-11-01 本轮用户授权扩修）：生产/全量 audit 0 已知漏洞，逐项证据见 docs/analysis/2026-11-01-t33-dependency-maintenance.md；未 force/降级/忽略/降门禁。后续公告回归时按同约束处理。 |';
d = d.replace(gateRow[0], gateNew);
fs.writeFileSync('docs/plans/development-progress.md', d, 'utf8');
console.log('progress doc updated; gate row was:', gateRow[0].slice(0, 80));
