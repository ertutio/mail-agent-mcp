# 当前开发依赖审计与 CI 证据

采集时间：2026-10-17 05:40:02 UTC。固定副本：work/mail-agent-understand-20261017。仅执行一次 npm audit --json；未运行 audit fix、install、更新锁文件或配置，也未重跑 CI。完整 npm JSON 响应保存在同目录的 dependency-audit-current.json。

## 当前全量 audit

命令返回退出码 1，stdout 是有效 JSON。npm audit 计出 6 个易受影响的 package 节点：3 high、3 moderate、0 critical。依赖统计为 prod 187、dev 187、optional 104、total 398；这些计数可能重叠，不应相加解读。当前 lockfile 的 6 个漏洞节点均标记 dev=true，且都不是生产依赖；3 个 direct dev dependency 为 vitest、@vitest/coverage-v8、nodemon，其余 3 个是传递依赖。

6 个节点来自 2 个独立 advisory，不是 6 个独立漏洞：

| 独立 advisory | 当前包节点及路径 | 触发/可达边界 |
| --- | --- | --- |
| GHSA-82fw-gwwq-j7x9，CWE-22，CVSS 5.9；Vitest 的 @vitest/mocker redirect mock 路径穿越/任意文件读取，影响范围 >=2.1.0 <4.1.11 | vitest 4.1.10（direct dev）；@vitest/mocker 4.1.10（transitive，直接列 advisory）；@vitest/coverage-v8 4.1.10（direct dev，audit 通过 vitest 标为 affected-through）。三者 lock 节点全是 dev=true。 | 需要在开发测试中执行受影响版本的 Vitest redirect-mock 路径。audit 证明依赖可在测试环境加载，不证明项目收到攻击者控制的 mock 目标，也没有在本轮测试或演示利用。不会通过生产依赖安装进入应用 runtime。 |
| GHSA-vfj7-8cjw-p6xm，CWE-674，CVSS 7.5；braces 深层嵌套模式可能导致栈耗尽，影响范围 <=3.0.3 | nodemon 3.1.14（direct dev）→ chokidar 3.6.0（transitive）→ braces 3.0.3（transitive）。三者 lock 节点全是 dev=true；audit 把 chokidar、nodemon 记为受 braces 影响的父节点。 | 需要开发时运行 nodemon/chokidar，并让足够深的 brace pattern 到达 braces 解析器。audit 证明该开发依赖路径存在，不证明应用接受攻击者控制的 pattern，也不表明该代码在生产 server 请求路径中执行。 |

npm audit 对以上 6 个节点都给出 fixAvailable=false。这表示本次 audit 没有提供当前清单可直接采用的修复建议；不等同于已经证明不存在可升级版本或替代方案。没有尝试更改任何依赖或锁文件。

这次全量审计中没有一个漏洞节点标记为生产依赖，所以当前响应未报告生产依赖漏洞。没有另跑 npm audit --omit=dev；因此没有单独的生产-only audit 结果可报告。文件锁中的 dev=true 和依赖边是本次生产/开发分类依据。

## ENG-01 状态

ENG-01 仍未解决：当前全量 audit 仍非零，且 advisory 节点全是开发工具依赖。它继续阻止“完整依赖树 audit 为零”的结论，并保持计划中的范围例外/发布门槛；现有证据不支持把它描述成生产依赖漏洞。项目计划要求维护者先明确是否解除此前的开发依赖排除，再安排升级、兼容性验证和回归。本轮没有升级。

之前 PR #2 正文记录生产依赖审计 0、全量审计留有 6 个开发依赖条目；这只是 2026-10-16 的历史记录。本次当前全量 audit 的六节点结果与之相符，但本次没有单独运行生产-only audit。

## GitHub Actions

对已合并 main commit 96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca 执行只读查询：

gh run list --repo ertutio/mail-agent-mcp --commit 96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca --limit 20 ...

返回空数组。查询时没有找到关联的 GitHub Actions run，因此当前 CI 状态不可确认；空数组不代表 CI 通过。本轮没有创建或重跑 workflow。

## 证据和边界

当前 audit 响应为 dependency-audit-current.json。版本和 dev/prod 归属来自固定副本的 package.json 与 package-lock.json；没有读取账号、vault、邮件或 token。GitHub Actions 结果只代表对指定 commit 的只读 run-list 查询。