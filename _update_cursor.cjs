const fs = require('fs');
let d = fs.readFileSync('docs/plans/development-progress.md', 'utf8');
// 全局阻塞行：T33 已解除
const oldBlock = '| 全局阻塞 | 剩余 prod 5 / full 8 moderate 依赖公告未扩修；T33 扩展维护、T34/T36 门控保留；真实服务商、WinCred、部署和发布不由本轮代码验收替代。 |';
if (!d.includes(oldBlock)) throw new Error('global block row not found');
d = d.replace(oldBlock, '| 全局阻塞 | 依赖公告已清零（生产/全量 audit 均 0，见 docs/analysis/2026-11-01-t33-dependency-maintenance.md，本轮授权扩修）；T34/T36 门控保留；真实服务商、WinCred、部署和发布不由本轮代码验收替代。 |');
// T33 保留门控行
const oldGate = '| T33 扩展依赖维护 | `awaiting_human`；生产 5 / 全量 10 moderate 是本轮快照，实施时重查公告。原高危最小修复授权不扩为任意升级；不 audit fix、不降阈值。 |';
if (!d.includes(oldGate)) throw new Error('T33 gate row not found');
d = d.replace(oldGate, '| T33 扩展依赖维护 | 已完成（本轮授权扩修）：生产/全量 audit 0 已知漏洞，逐项证据见 docs/analysis/2026-11-01-t33-dependency-maintenance.md；未 force/降级/忽略/降门禁。后续公告回归时按同约束处理。 |');
fs.writeFileSync('docs/plans/development-progress.md', d, 'utf8');
console.log('progress doc updated');
