# 分析证据、覆盖及限制

本轮分析日期为上海时间 2026-10-17；分项采集时间保存在对应 JSON。仓库快照、扫描、探针、审查和依赖结果是不同证据，不相互代替。入口见 START-HERE，行为/符号/版本定位见 CODE-KNOWLEDGE。

## 证据台账

| 类型 | 本轮实际做了什么 | 结论与限制 | 产物/来源 |
| --- | --- | --- | --- |
| GitHub / Git | gh只读查repo、PR、main递归tree；本地status/tree | PUBLIC；main96f8864与524e1b3整树相等；本地origin/main过期；原检出起止干净 | baseline-deployment.json、github-version-comparison.json；PR #1/#2 |
| 计划 / 静态 | 读原计划、31项原审计及补充SA-08、架构/集成/发布文档、相关调用链 | 文件为当前入口；PR #2已合并，旧“未部署/合并”文字过期；原32项全部映射 | 固定副本docs/；ROADMAP-PR-BODY |
| 安装磁盘 | 窄范围manifest/marker/src/public/dist/hash比对 | 旧detached clone上有overlay；四个dist一致、src/public换行归一一致；manifest仅files差异；不等于内存版本 | baseline-deployment；未执行安装脚本 |
| 注册 | 白名单投影Codex mail-agent段与launcher代码 | 注册存在，launcher注入全40工具模式；没有输出env值 | baseline-deployment；注册不等于transport |
| 当前进程 | 窄范围launcher/server父子查询 | 4对进程指向安装dist；启动时间晚于文件mtime是关联线索，未直接证明内存commit | baseline-deployment；不杀/重启任何服务 |
| 当前MCP / 真实账户 | **未执行** tools/list、代表性call、账户连接或邮箱读写 | 当前client可用性、真实provider兼容和运行版本仍缺证 | NOT RUN；未读真实账户/vault/邮件/token |
| 确定性结构 | Understand Anything bundled scan/import/structure/fingerprints | 143分类文件、41生产模块、211内部import；结构140成功/0不可读；3不支持解析 | 固定副本`knowledge/tmp/`与`knowledge/intermediate/scan-result.json` |
| 人工语义 | 主代理给生产模块角色/架构层，追踪E01–E10关键链与失败/恢复 | 不声称逐行读完全部文件；图调用边仅选定文件级关系 | MODULE-INDEX、CODE-KNOWLEDGE、`knowledge/coverage.json` |
| 测试存在 | 提取现有68测试文件的导入/静态测试标题并阅读相关断言 | 标题索引不是测试运行计数，动态each/运行分支不能由索引穷尽 | `knowledge/test-index.json`；定点阅读深度见coverage |
| 合成实际执行 | 五个内存mock/gate观察，使用实际service/handler；游标通过真实Zod校验 | MAIL-01、SA-04缺口与N-01/N-02/N-03观察均出现；不是修复后PASS，也不是协议服务验证 | probes.mts、probe-results.json（带SHA/时间） |
| 本地模拟协议服务 | **本轮未执行**TCP/TLS/SMTP服务器测试 | SEC-02/MOVE/EXPUNGE网络实境仅静态+历史审计；后续任务以受控协议服务验收 | NOT RUN；没有直接执行外部审计复现脚本 |
| 原修复历史 | 读2026-10-16交付/日志，且核对相同source tree | SA-08 21、SEC-01 12定点历史通过；662通过/1跳过、81.93%覆盖为历史；当前环境没有重跑 | 原计划、PR #2、work/mail-agent-two-fixes-review-20261016/validation.txt |
| build/test/coverage/pack/秘密扫描 | **本轮未重跑产品命令** | 无源码改变，复用相关历史证据，不宣称本轮全量成功 | 历史可比性不覆盖环境/依赖公告变化 |
| 最新依赖审计 | 一次全量npm audit JSON | 退出1，6开发包节点、2公告；不是6独立漏洞，非生产路径告警；不改锁/包 | dependency-audit-current.json、dependency-evidence.md |
| CI | gh查main commit关联run | 返回空数组，未发现run；不是CI通过或失败，未触发CI | dependency-evidence；不得跳过未来强制CI |
| 独立审查 | 一次隔离DeepSeek read-only会话，7个公开源码文件；主代理核对 | 1/2支持；第3转向rawMessage缺失，未证明APPEND false可达；后者由主代理依赖源码+mock核实 | review-task、review-plan、review-result，见下节 |
| 产物校验 | 确定性图/覆盖/映射/依赖/引用/原检出状态检查 | 结果以analysis-validation.json为准；不能外推业务正确 | validate-analysis.mjs、`knowledge/intermediate/review.json` |

## Understand Anything 的执行方式

已读取用户指定的当前技能与 project-scanner/file-analyzer 定义。插件已有core build，无安装/升级。原项目没有可复用的 `.ua` 或 legacy知识图谱；在固定git archive副本重建。用户要求保留全库模块索引，未为143文件额外要求缩小范围；使用中文，跳过dashboard、可视化和教学tour。原仓配置/忽略文件/自动更新hook均未改变；副本没有自动刷新服务。

扫描、导入解析、结构与指纹使用原技能 bundled scripts；没有手写替代解析器。主代理承担语义/架构整合（当前主会话Sol推理强度无已验证值，不伪设Sol子代理）。13层和手工行为边经过确定性校验；不为形式固定启动全图LLM审查。Luna以gpt-6-luna/max核对基线、部署及依赖。独立技术审查只做一次限界复核。

Git共146个blob，插件默认扫描排除`.gitignore`、`LICENSE`、`package-lock.json`，实际扫描143。许可证与忽略文件不作语义调用分析；lock另外核对blob/hash及依赖路径。Windows archive部分文件为CRLF；首次严格字节校验发现换行差异，随后确认仅CRLF→LF即可匹配原Git blob，并在校验结果分别记录字节一致/换行归一一致数量，没有修改副本源码。3个结构解析不支持的文件已读并分类；图并未冒称有它们的AST。全部生产src均在扫描集合，无生产模块遗漏。`knowledge/coverage.json`记录每个扫描文件分类、blob、内容hash、提取情况与实际阅读深度；机器图谱里的函数语义有些仅模块职责注释，不能等同完整函数审计。

以后只在相关源码/接口/依赖改变或有具体覆盖缺口时刷新对应知识。副本是固定分析证据，不作为开发工作树。需要增量分析时先与当前任务diff核对再生成新副本/局部结果，不在旧副本直接运行git增量助手冒充新基线。

## 五个合成观察的解释

- MAIL-01：真实service方法配合内存锁模型，INBOX锁内暂停时裸SELECT切Archive，后续UID命令记录Archive。它解决“旧审计能否套当前代码”的具体疑问；下一轮应把期望“保持INBOX”写为正式反例。
- SA-04：LIST抛错后failed/partial且cursors为空；重跑第一次查询当然可恢复，但“仅靠返回游标恢复”契约不成立。
- N-01：同ID账户身份改变仍进入mocked SMTP；删除同名邮箱且相同UIDVALIDITY场景为静态条件推断，未实际删除。
- N-02：真实schema允许将cursor名称从alpha改beta，filterKey不变，实际handler调用synthetic-b。它证明无身份绑定，不证明绕过权限；账户均为合成可访问账户。
- N-03：实际ImapService在client.append=false时两条保存路径均返回成功。锁定imapflow1.6.5的公开方法将未执行结果归一为false；真实时序尚未做协议复现。草稿handler已有false检查，不能把责任错放调用者。

探针最初被沙箱的tsx系统用户查询错误阻止；该次未执行，不算产品失败。经批准仅扩大本地执行环境后成功。新增MAIL-01后刷新同一结果；没有因此重复全量测试。所有数据均合成，SMTP/IMAP都是mock，无外部邮件副作用。

## 外部审查的授权、状态和核对

首次隔离干跑因沙箱可执行文件访问失败；升权干跑又被自动审批以“源码外发目的地未明确”为由拒绝。随后以gh证实PUBLIC和快照与公开main整树相同，并证明dry-run在CLI/API之前返回；证据充分后干跑和实际限界审查获准。未绕过拒绝，也没有更换外部目的地。输入为review-task列明的公开源码，没有账户数据、邮件或密钥。

请求 `deepseek-flash[1m]`/max/review/Read，结果success=true、review_complete=true、无permission_denials；实际消息名 `deepseek-flash`，CLI有unrecognized_model警告，不能证明服务端1m上下文。CLI结果的cost字段为0.430331 USD，costBasis=unknown；它是CLI报告值，不是已核实账单。记录input 20,943、cache-read 15,232、output 12,720；不把这些转换成无法验证的Plus百分比，也不称零成本。

主代理采纳预览身份/游标绑定的有条件结论；补读AccountManager证明名称唯一但可重命名/重建、存在ID优先规则。第三项审查没有确认底层false，而提示rawMessage缺失时warning遗漏；主代理核对后将该静态条件合并MAIL-03/T22，未额外立高优先级漏洞。APPEND false则有独立的锁定依赖行号及mock观察。没有叠加第二轮审查或Astra咨询。CLI完成只说明该会话返回，采纳边界由主代理负责。

## 当前剩余缺口

实际运行进程内存版本、当前客户端成功调用、真实provider/Windows vault/最低Node平台、当前源码在新环境的全量测试和未来CI均未在本轮证明。新游标契约、非秘密revision与可信人类审批通道都尚未设计实施。原始30个未闭合项仍需按所领任务形成FAIL→PASS，不能由这份分析关闭。计划交付后停止，下一轮仅在维护者选择后开始。
