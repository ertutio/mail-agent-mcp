// Archived analysis script: historical workspace layout required; not a product/CI entry.
// Builds analysis artifacts from Understand Anything's bundled deterministic outputs.
// This is assembly/annotation, not a replacement source/import parser.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const out=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(out,'../../work/mail-agent-understand-20261017');
const ua=path.join(root,'.ua');
const read=p=>JSON.parse(fs.readFileSync(path.join(ua,p),'utf8'));
const save=(p,o)=>fs.writeFileSync(path.join(ua,p),JSON.stringify(o,null,2)+'\n');
const scan=read('tmp/scan.json'), imports=read('tmp/import-output.json'), structure=read('tmp/structure.json');
if(!scan.scriptCompleted||!imports.scriptCompleted||!structure.scriptCompleted||structure.filesUnreadable.length)throw Error('Incomplete extraction');
const baseline='524e1b34c89ebe2834a27b948371227f142d346d';
const main='96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca';
const roles={
 'src/index.ts':['process','组装 stdio MCP、账户/凭据解析器及 IMAP/SMTP 服务，注册工具。','full'],
 'src/enroll.ts':['enrollment','可信本地 CLI 收集输入，提供 QQ/网易/Gmail 注册与 QQ/Gmail 修复。','targeted:75-88,141-360'],
 'src/setup.ts':['enrollment','设置页启动与可选 Claude Desktop 配置写入；路径/覆盖问题仍在。','full'],
 'src/tools/index.ts':['tools','统一工具白名单、只读集合、直接发送封禁和删除代理装配。','full'],
 'src/tools/account-tools.ts':['tools','只读账户列表、连接/断开、既存账户连接测试。','full'],
 'src/tools/email-tools.ts':['tools','搜索/读取/附件、旗标、移动、删除候选、草稿及已封禁旧发送处理器。','targeted:1-135,165-380,386-592,766-1018,1071-1133;surface:remaining'],
 'src/tools/folder-tools.ts':['tools','文件夹列表/状态/创建与未读统计；状态 SELECT 绕锁、统计错误归零待修。','full'],
 'src/tools/unified-search-tools.ts':['search','选择任意数量账户，最多三账户并发、逐文件夹 UID 分页、全局 top-K 与覆盖/续查反馈。','full'],
 'src/tools/guarded-delete-tools.ts':['mutation','截获五个删除入口，冻结 UIDVALIDITY/UID/永久性，确认后统一 bulkDelete。','full'],
 'src/tools/safe-send-tools.ts':['mutation','新信/回复/转发预览物化附件，确认触发 SMTP，Sent 副本 best effort。','full'],
 'src/tools/spam-tools.ts':['tools','本地垃圾特征、域统计/名单管理及经删除代理包装的垃圾/域删除。','targeted:92-178,308-378;surface:other registrations'],
 'src/services/imap-service.ts':['transport','IMAP 连接缓存/重连、锁、UID 查询、MIME 读取、旗标、移动删除和 APPEND 共用实现。','targeted:1-541,677-875,912-941,989-1085,1118-1370,1538-1783;surface:remaining'],
 'src/services/smtp-service.ts':['transport','按账户缓存 transporter，TLS/代理/认证，独立 MIME 编译和 SMTP 提交。','full'],
 'src/services/account-manager.ts':['account-state','隔离目录账户存储、加密/env 覆盖、选择、跨进程写事务与 provider 持久化约束。','targeted:1-310,364-483,503-568;surface:311-363'],
 'src/services/safe-send-service.ts':['mutation','内存草稿冻结、容量/TTL、单次确认及 ambiguous 禁止重发状态机。','full'],
 'src/services/spam-service.ts':['content','确定性域/头启发式、白名单优先及域统计；不执行运行时模型判断。','targeted:118-239,252-391;surface:constants and list mutators'],
 'src/services/html-to-markdown.ts':['content','清洗 HTML 并转换 Markdown，规范正文空白。','structural+surface'],
 'src/credentials/account-auth.ts':['credentials','读取 SecretHandle、校验精确 vault target/provider 端点，生成 IMAP/SMTP 认证配置。','full'],
 'src/credentials/account-enrollment.ts':['credentials','provider 注册的 vault 写入、可选验证、账户提交与回滚事务。','full'],
 'src/credentials/credential-backend.ts':['credentials','SecretHandle/后端契约与新/旧 target 命名规则。','structural+surface'],
 'src/credentials/credential-rotation.ts':['credentials','凭据替换/验证/回滚；尚无跨进程账户版本重验。','full'],
 'src/credentials/gmail-oauth-loopback.ts':['credentials','回环 PKCE 浏览器授权、回调、授权码换令牌与清理。','targeted:1-165,245-329;surface:callback handler'],
 'src/credentials/gmail-token-exchange.ts':['credentials','refresh token 换 access token、网络错误分类和代理生命周期。','full'],
 'src/credentials/proxy-fetch.ts':['transport','标准 env 代理或 Gmail 强制 dispatcher 的 HTTP fetch 封装与 close。','full'],
 'src/credentials/windows-credential-backend.ts':['credentials','Koffi WinCred 适配与 SecretHandle 零化；本轮未访问系统凭据。','targeted:1-85;structural+surface:remaining'],
 'src/providers/email-providers.ts':['enrollment','设置页服务商端点/能力提示目录与 email/host 查询；不是实际认证策略。','structural+surface'],
 'src/web/server.ts':['enrollment','私有设置会话、同源/Host 防护、账户 CRUD/测试、HTTP 生命周期。','targeted:1-140,175-375,405-470;surface:remaining'],
 'src/web/enrollment-router.ts':['enrollment','严格 provider 输入、注册互斥与 Gmail 异步 job 状态；202 不代表已注册。','full'],
 'src/types/index.ts':['contracts','账户认证、邮件/附件、查询和 Sent 回执类型；无账户 revision/稳定附件 part。','full'],
 'src/types/turndown-plugin-gfm.d.ts':['contracts','Turndown GFM 插件的本地 TypeScript 声明。','structural'],
 'src/utils/account-store-lock.ts':['account-state','文件 wx 锁串行化跨进程账户写入，5 秒超时，异常退出需人工判定陈旧锁。','full'],
 'src/utils/array-input.ts':['contracts','恢复客户端序列化数组的兼容输入。','structural+surface'],
 'src/utils/attachment-root.ts':['content','附件读写 realpath 边界和 link/junction 检查。','full'],
 'src/utils/default-bcc.ts':['content','默认与显式 BCC 的裸地址去重；safe-send 另有局部实现，属于调用者核对点。','full'],
 'src/utils/env-credentials.ts':['credentials','账户名到 env key 的映射和空凭据拒绝；不读取系统 vault。','full'],
 'src/utils/gmail-proxy.ts':['transport','Gmail 专用/标准代理与 Windows loopback 回退，缺代理拒绝。','full'],
 'src/utils/mail-proxy.ts':['transport','QQ/网易直连、Gmail 强制代理、其他 provider 的通用代理策略。','full'],
 'src/utils/mail-resource-limits.ts':['content','25 MiB MIME/附件、正文/数量上限及有界文件物化。','full'],
 'src/utils/pdf-preview.ts':['content','限制输入/页面/输出/并发的 PDF 子进程和 5 秒终止。','full'],
 'src/utils/search-folders.ts':['search','按 selectable、SPECIAL-USE/名称过滤 Trash/Spam/Drafts 等文件夹。','full'],
 'src/utils/windows-system-proxy.ts':['transport','只读 Windows 代理设置并仅接受启用的 loopback 地址。','full']
};
const testDeep=new Set(['tests/folder-tools-status.test.ts','tests/guarded-delete.test.ts','tests/unified-search.test.ts']);
const testTarget=new Set(['tests/unified-search-pagination.test.ts','tests/safe-send-tools.test.ts','tests/email-tools-pdf-extract.test.ts','tests/imap-service-sent-save.test.ts','tests/imap-service-tls-host.test.ts','tests/email-tools-sent-save.test.ts']);
const extraction=new Map(structure.results.map(r=>[r.path,r]));
function layerFor(f){if(roles[f])return roles[f][0];if(f.startsWith('tests/'))return 'verification';if(f.startsWith('public/'))return 'enrollment';if(f.startsWith('docs/')||f.endsWith('.md'))return 'documentation';return 'packaging';}
function fileType(f){if(f.path.startsWith('.github/'))return 'pipeline';return ({config:'config',docs:'document'})[f.fileCategory]||'file';}
function description(f){if(roles[f.path])return roles[f.path][1];if(f.path.startsWith('tests/'))return '回归用例：'+f.path.slice(6).replace('.test.ts','')+'；本轮执行状态见验证台账。';if(f.fileCategory==='docs')return '项目文档：'+f.path+'；按任务条件读取。';if(f.path.startsWith('.github/'))return 'GitHub 配置/流水线：'+f.path+'；结构已索引，未执行 CI。';if(f.path.startsWith('public/'))return '本地账户设置页面资源：'+f.path+'。';return '构建、安装或项目配置：'+f.path+'。';}
const nodes=[],edges=[],coverage=[],modules=[];const fileIds=new Map();
const sourceManifest=execFileSync('git',['-C',path.resolve(root,'../mail-agent-audit'),'ls-tree','-r',baseline],{encoding:'utf8'}).trim().split('\n').map(l=>{const [meta,p]=l.split('\t');return {path:p,blob:meta.split(' ')[2]};});
const blobs=new Map(sourceManifest.map(x=>[x.path,x.blob]));
for(const f of scan.files){
 const type=fileType(f),id=type+':'+f.path;fileIds.set(f.path,id);
 const s=extraction.get(f.path),layer=layerFor(f.path);
 const depth=roles[f.path]?.[2]||(testDeep.has(f.path)?'full':testTarget.has(f.path)?'targeted':f.path.startsWith('tests/')?'structural+test-title-index':'structural+surface');
 const sha256=createHash('sha256').update(fs.readFileSync(path.join(root,f.path))).digest('hex');
 nodes.push({id,type,name:path.basename(f.path),filePath:f.path,summary:description(f),tags:[layer,f.fileCategory,f.path.startsWith('tests/')?'test':'project'],complexity:f.sizeLines>200?'complex':f.sizeLines>50?'moderate':'simple',provenance:{method:roles[f.path]?'human-trace-and-structural':'deterministic-structure-with-surface-annotation',commit:baseline,readingDepth:depth}});
 coverage.push({...f,blob:blobs.get(f.path),sha256,extraction:s?'parsed':'unsupported-parser',readingDepth:depth,bodyReadCompletely:depth==='full',execution:'not-run-unless-listed-in-evidence-ledger'});
 if(roles[f.path])modules.push({path:f.path,role:roles[f.path][1],layer,dependencies:imports.importMap[f.path]||[],externalDependencies:'See source imports/package-lock; internal map excludes npm/system imports.',readingDepth:depth,commit:baseline});
 if(s&&f.path.startsWith('src/')){
  for(const c of s.classes||[]){const cid='class:'+f.path+':'+c.name;nodes.push({id:cid,type:'class',name:c.name,filePath:f.path,lineRange:[c.startLine,c.endLine],summary:description(f)+' 类型/类 '+c.name+'。',tags:[layer,'declaration','class'],complexity:'moderate',methods:c.methods||[],provenance:{method:'bundled-structural-extraction',commit:baseline}});edges.push({source:id,target:cid,type:'contains',direction:'forward',weight:1,provenance:'deterministic'});}
  for(const fn of s.functions||[]){if(fn.endLine-fn.startLine<5)continue;const fid='function:'+f.path+':'+fn.name;nodes.push({id:fid,type:'function',name:fn.name,filePath:f.path,lineRange:[fn.startLine,fn.endLine],summary:'模块 '+path.basename(f.path)+' 的 '+fn.name+'；所属职责：'+roles[f.path][1],tags:[layer,'declaration','function'],complexity:fn.endLine-fn.startLine>100?'complex':'moderate',provenance:{method:'bundled-structural-extraction; responsibility is module-level annotation, not full function review',commit:baseline}});edges.push({source:id,target:fid,type:'contains',direction:'forward',weight:1,provenance:'deterministic'});}
 }
}
for(const [from,tos] of Object.entries(imports.importMap))for(const to of tos)if(fileIds.has(to))edges.push({source:fileIds.get(from),target:fileIds.get(to),type:'imports',direction:'forward',weight:0.7,provenance:'bundled-deterministic-import-resolution'});
// Explicitly read relationships only; graph is a retrieval index, not complete call resolution.
const semantic=[
 ['src/index.ts','src/tools/index.ts','calls','registerTools'],
 ['src/tools/index.ts','src/tools/guarded-delete-tools.ts','calls','guardedDeletion'],
 ['src/tools/folder-tools.ts','src/services/imap-service.ts','calls','folder_status -> getFolderStatus + selectFolder'],
 ['src/tools/unified-search-tools.ts','src/services/imap-service.ts','calls','listFolders/searchEmailPage/abortConnection'],
 ['src/tools/guarded-delete-tools.ts','src/services/imap-service.ts','calls','confirm -> bulkDelete'],
 ['src/tools/safe-send-tools.ts','src/services/safe-send-service.ts','calls','preview/confirm'],
 ['src/tools/safe-send-tools.ts','src/services/smtp-service.ts','calls','executor -> sendEmail'],
 ['src/tools/safe-send-tools.ts','src/services/imap-service.ts','calls','saveSentBestEffort -> appendToSentFolder'],
 ['src/tools/email-tools.ts','src/utils/attachment-root.ts','calls','download/upload path boundary'],
 ['src/services/imap-service.ts','src/utils/pdf-preview.ts','calls','body attachment preview only'],
 ['src/enroll.ts','src/credentials/credential-rotation.ts','calls','QQ/Gmail repair'],
 ['src/web/server.ts','src/web/enrollment-router.ts','calls','protected /api router'],
 ['build.mjs','src/index.ts','deploys','bundle entry'],
 ['build.mjs','src/setup.ts','deploys','bundle entry'],
 ['build.mjs','src/enroll.ts','deploys','bundle entry'],
 ['build.mjs','src/web/server.ts','deploys','bundle entry']
];
for(const [a,b,type,note] of semantic)edges.push({source:fileIds.get(a),target:fileIds.get(b),type,direction:'forward',weight:type==='calls'?0.8:0.7,provenance:'manual-code-trace',note});
const names={process:'进程装配',tools:'MCP 工具',search:'跨账户检索',mutation:'副作用与确认',transport:'协议和路由',credentials:'认证与凭据',enrollment:'本地设置',contracts:'类型契约','account-state':'账户状态',content:'正文附件',verification:'验证',documentation:'文档',packaging:'打包与安装'};
const layers=Object.entries(names).map(([id,name])=>({id:'layer:'+id,name,description:name+'职责和相关文件。',nodeIds:scan.files.filter(f=>layerFor(f.path)===id).map(f=>fileIds.get(f.path))})).filter(l=>l.nodeIds.length);
const project={name:'mail-agent-mcp',description:'本地 stdio 邮件 MCP；账户/搜索/确认式发送和删除。',languages:[...new Set(scan.files.map(f=>f.language))].sort(),frameworks:['MCP SDK','Express','Vitest'],analyzedAt:new Date().toISOString(),gitCommitHash:baseline};
save('intermediate/scan-result.json',{...scan,name:project.name,description:project.description,languages:project.languages,frameworks:project.frameworks,importMap:imports.importMap});
save('knowledge-graph.json',{version:'1.0.0',project,nodes,edges,layers,tour:[],analysis:{remoteMainCommit:main,tree:'f1755af6f8c67d7d40ca22ea1da870e542e7d993',equivalence:'Entire Git tree identical to remote main; original checkout untouched.',scope:'retrieval graph; no dashboard or teaching tour by user instruction',calls:'manual selected file-level calls only; raw syntax callGraph retained in tmp/structure.json, not complete runtime dispatch',declarationLimits:'Only supported significant top-level functions and class/interface declarations are graph nodes. Class method names retained on class nodes; exact per-method ranges not emitted by bundled parser.'}});
save('module-index.json',{commit:baseline,modules});
save('coverage.json',{commit:baseline,scanned:scan.totalFiles,productionModules:modules.length,structuralStats:structure.analysisOutcomes,unsupported:structure.filesSkipped,files:coverage,excluded:{defaultScannerExclusions:'node_modules, .git, generated dist/coverage, lockfile and built-in defaults; not semantic coverage',additional:['source.tar','.ua/','.git/'],notScannedButInspected:['package-lock.json (version and dependency reachability only)']}});
save('intermediate/fingerprint-input.json',{projectRoot:root,filePaths:scan.files.map(f=>f.path),gitCommitHash:baseline});
const md=['# 生产模块索引','','基线 `'+baseline+'`，与远端 main Git tree 完全一致。内部依赖为 Understand Anything 确定性提取；外部包见源文件及 lock。阅读深度精确记录在 coverage.json。','','| 模块 | 职责 | 内部依赖 | 实际阅读深度 |','| --- | --- | --- | --- |',...modules.map(m=>'| `'+m.path+'` | '+m.role+' | '+(m.dependencies.map(p=>'`'+p+'`').join(', ')||'无项目内 import（仍可能调用 npm/系统）')+' | '+m.readingDepth+' |')].join('\n')+'\n';
fs.writeFileSync(path.join(out,'MODULE-INDEX.md'),md);
console.log(JSON.stringify({files:scan.totalFiles,modules:modules.length,nodes:nodes.length,edges:edges.length,layers:layers.length,unsupported:structure.filesSkipped}));
