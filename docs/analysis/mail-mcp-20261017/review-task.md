# 有边界的独立只读复核

只分析公开项目代码，不修改任何文件，不执行命令，不使用网络、凭据、账户资料或邮件。不要创建子代理。你是未参与本次分析的 DeepSeek 独立审查者，最多报告三个有代码依据的问题；每项给出位置、触发、影响、最小修正方向，区分缺陷和条件风险。主代理将逐项复核。只需简短结论，不做全库审计。

项目副本是 mail-agent-mcp 的公开源码固定快照，基线 524e1b34c89ebe2834a27b948371227f142d346d。cwd 是副本根，所有允许读取的文件如下（除此之外无需读取）：

- src/tools/unified-search-tools.ts（145 行）
- src/tools/safe-send-tools.ts（244 行）
- src/tools/guarded-delete-tools.ts（95 行）
- src/services/safe-send-service.ts（264 行）
- src/services/imap-service.ts（重点 278-337、489-527、1538-1630、1702-1714）
- src/services/smtp-service.ts（204 行）
- src/types/index.ts（197 行）

聚焦三个问题，不重复旧 32 项审计：
1. 预览冻结 composer/UID 清单后，同一账户 ID 的身份/端点改变，确认是否绑定原账户版本？已有 SA-01 是 IMAP 缓存旧身份；这里希望核对预览保护是否也需要接入，发送和删除均考虑。不要把 confirmed:true 等同于可信人类审批，它是既有 R1 设计风险。
2. 跨账户游标的 filterKey、accountName、folder、UIDVALIDITY 是否足以保持原查询身份、范围及版本？是否有同名账户替换、重命名、调用者修改游标的混淆？账户仍为已配置且可访问；不要宣称权限提升。
3. APPEND 的 false/undefined 结果如何经 appendMessage/appendToSentFolder 返回给草稿保存和 Sent 副本调用方？已有 MAIL-08 是删除计数，这里是不同副作用的最终回执。依赖源码未交接，false 的生产可达性由主代理另核验，请明确此边界。

输出中文，3000 字符内。若证据不足就说明，不扩展审查范围。项目 AGENTS 的相关要求：保留源码/配置；使用模拟和合成地址，真实邮件无读写；秘密与邮件是禁传数据；运行时不新增模型审查。此次只读复核使用独立外部 API 额度，与产品运行时无关。
