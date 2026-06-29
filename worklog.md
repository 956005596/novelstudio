# NovelStudio — Worklog

---
Task ID: 1-11
Agent: main (super-z)
Task: 基于 NovelStudio 设计文档实现 MVP（Next.js 全栈 + GLM + 网游升级模板 + 端到端可运行 Demo）

Work Log:
- 加载 fullstack-dev skill，初始化 Next.js 16 项目环境（端口 3000）
- 设计 Prisma 数据模型：Project / Character / Event / Chapter / Directive，推送到 SQLite
- 实现 LLM 封装层 `src/lib/novel/llm.ts`：基于 z-ai-web-dev-sdk 接入 GLM-4.6，支持 chat() 和 chatStream()，内置 429/5xx 重试与指数退避
- 实现网游升级风格模板 `src/lib/novel/templates/online-game.ts`：3 个预设角色（林墨/苏晚/赵铁柱）、6 种场景类型、叙事调性与 Writer 风格指南
- 实现 World State 管理器 `src/lib/novel/world-state.ts`：共享黑板模式，事件日志不可变追加，支持 World State patch 和角色状态 patch
- 实现 Director Agent `src/lib/novel/agents/director.ts`：决策（选谁行动/注入事件/触发 Writer/张力调整）+ 仲裁（多角色提案冲突解决）
- 实现 Character Agent `src/lib/novel/agents/character.ts`：第一人称视角行为提案，符合 persona.stance 和 goals
- 实现 Writer Agent `src/lib/novel/agents/writer.ts`：事件日志→小说文本，含 Style Anchor（最近 2000 字作为风格锚点），流式输出
- 实现 Engine 编排循环 `src/lib/novel/engine.ts`：Director 决策 → 角色提案 → 仲裁 → 提交事件 → 更新 World State → 触发 Writer
- 实现 Socket.io mini-service `mini-services/novel-engine/`（端口 3003）：双工通信，支持 engine:start/pause/resume/stop、director:command、world:edit、character:edit、writer:rewrite
- 实现 6 个 API 路由：/api/projects (CRUD)、/api/projects/[id]/characters、/events、/chapters、/export、/director-lvl
- 实现前端 UI：
  - SetupPanel：项目列表/创建/删除
  - LiveView：三栏布局（角色面板 | 事件日志+Writer 输出 | 干预面板）
  - Zustand store：Socket.io 连接、状态同步、事件累积
- Agent Browser 端到端验证：
  - 创建项目 → 进入 → 启动演绎 → Director 决策 → 角色行动 → Writer 流式生成
  - 测试暂停/继续/停止
  - 测试 Director 指令干预（"让赵铁柱偷袭林墨被苏晚发现"）→ 指令被 Director 落实到下一 Turn
  - 测试导出（Markdown 格式，5 章 3155 字）
  - 修复问题：socket.io-client 未安装、Director 用角色名而非 ID、429 限流重试、停止按钮状态
- 最终状态：Turn 9，92 个事件，Writer 输出 4980 字，8 个段落，张力 10/10

Stage Summary:
- 完整实现了 NovelStudio 设计文档中的三层 Agent 架构（World State / Character / Director + Writer）
- 多 Agent 自主演绎验证通过：Director 调度、角色第一人称提案、Writer 演绎（非总结）文本生成
- 干预机制完整闭环：暂停 → 发送 Director 指令 → 继续 → 指令在下一 Turn 落实
- 网游升级风格模板表现良好：技能名「」括起、装备/属性描写、角色说话风格符合人设
- LLM 限流问题通过指数退避重试解决（5 次重试，初始 1.5s backoff）
- 文件结构：
  - src/lib/novel/ (types.ts, llm.ts, world-state.ts, engine.ts, agents/, templates/)
  - src/app/api/projects/ (6 个路由)
  - src/components/novel/ (setup-panel.tsx, live-view.tsx)
  - src/store/novel-store.ts
  - mini-services/novel-engine/ (index.ts, manager.ts)
- 导出文件：/home/z/my-project/download/首杀试炼.md (5 章 3155 字)
- 截图：/home/z/my-project/download/novelstudio-running.png
