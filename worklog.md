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

---
Task ID: 12-17 (Outline AI 生成模式)
Agent: main (super-z)
Task: 用户反馈"没法定义大纲，AI 自动接入"——新增 AI 大纲解析入口

Work Log:
- 新增 Outline Parser Agent `src/lib/novel/agents/outline-parser.ts`：
  - 接受任意粒度大纲（一句话/多段/章节）
  - LLM 解析为：风格判断 + World State + 角色（含 persona/relationships）+ 剧情节点（plotNodes）
  - 自动互查 relationships（A 提到 B 时，B 也补一个镜像关系）
- 扩展 WorldState 类型加入 `plotNodes: PlotNode[]` 和 `writerHint?: string`
- 新增 API `POST /api/projects/from-outline`：调用 outline-parser 创建项目+角色+回填 presentCharacterIds
- 更新 Director Agent：决策时读取 plotNodes 作为"剧情骨架"，标注"当前应推进的节点"，注入"节点推进原则"
- 更新前端 SetupPanel：
  - Tabs 双模式：「AI 生成（输入大纲）」默认 / 「预设模板（快速启动）」
  - AI 模式：项目名（可空）+ 大纲 Textarea + 3 个示例快选按钮
  - 生成中显示 "AI 解析中…（约 10-20 秒）" 带 Loader2 旋转图标
- 更新 LiveView 右栏：新增"剧情节点"面板，显示 plotNodes 进度（✓/○），目标 Turn，描述
- Agent Browser 端到端验证：
  - 输入"退役剑士林墨回归新服…"大纲 → AI 生成项目"迷雾峡谷"
  - 4 个剧情节点（旧仇重逢/副本组队/危机初现/摊牌时刻）
  - 3 个角色（林墨/赵铁柱/苏晚）完整 persona+技能+属性+关系网
  - 启动演绎后 Director 旁白明确"旧仇重逢节点开启"，遵循骨架推进
  - Writer 输出 647 字演绎文本（非总结），技能名「」括起，符合网游爽文调性

Stage Summary:
- 解决了用户痛点：现在可以"直接发大纲，AI 自动接入"——无需手选模板/手填角色
- 大纲作为剧情骨架生效：Director 在决策时明确遵循 plotNodes，不会跑偏
- 预设模板保留作为快速启动选项，不破坏已有功能
- AI 解析能力验证通过：一句话简介 → 完整 World State + 角色 + 节点
- 文件变更：
  - 新增 src/lib/novel/agents/outline-parser.ts
  - 新增 src/app/api/projects/from-outline/route.ts
  - 修改 src/lib/novel/types.ts（+PlotNode, +plotNodes, +writerHint）
  - 修改 src/lib/novel/agents/director.ts（读取 plotNodes）
  - 重写 src/components/novel/setup-panel.tsx（Tabs 双模式）
  - 修改 src/components/novel/live-view.tsx（剧情节点面板）
- 截图：/home/z/my-project/download/novelstudio-outline-mode.png

---
Task ID: 18-23 (进度反馈 + 角色丰满度)
Agent: main (super-z)
Task: 用户反馈 1.进度不及时以为失败 2.角色和背景不够丰满（200w 字长篇支撑）

Work Log:
- 扩展类型字段：
  - WorldLore: premise / worldBackground / geography / factions / rules / themes / timeline
  - CharacterPersona: backstory / growthArc / innerConflict / secrets / motivations / speechHabits / appearance
- 重构 outline-parser 为 5 阶段流水线（每阶段独立 LLM 调用）：
  1. compressOutline   — 超长大纲压缩
  2. buildWorldLore    — 构建世界观（背景/势力/地理/规则/主题）
  3. buildCharacters   — 角色深度档案（背景故事/成长弧线/内在冲突/秘密/动机层次）
  4. buildPlotNodes    — 拆解剧情节点
  5. assembleWorldState — 组装并保存
- 每阶段通过 ProgressCallback 上报进度（stage/message/progress 0-100/detail）
- API 改为 SSE (Server-Sent Events) 流式返回：
  - event:progress 每阶段进度
  - event:done 完成信号（含项目 ID）
  - event:error 错误信息
- 前端 SetupPanel 接入 SSE：
  - 实时进度条（0-100%）
  - 5 阶段步骤指示器（压缩/世界观/角色/剧情/保存），每阶段显示 pending/running/done/error 状态
  - 取消按钮（AbortController）
  - 错误时显示红色卡片 + 重试按钮
- LiveView 增强：
  - 角色面板加"角色档案"可展开区域（背景故事/成长弧线/内在冲突/动机/秘密/说话习惯/外貌/技能）
  - 右栏新增"世界观设定"面板（故事前提/世界背景/时间线/地点/势力/规则/主题）
- Agent Browser 验证（修真界大纲测试）：
  - 进度实时显示：20% 构建世界观 → 55% 设计角色 → 完成
  - 生成 4 个角色，每个有完整深度档案
  - 苏寒角色档案实测：背景故事 300+字 / 成长弧线 / 内在冲突 / 2 个秘密 / 动机层次 / 外貌 / 技能
  - 世界观：5 大宗门势力 / 故事前提 / 世界背景

Stage Summary:
- 解决"以为失败"问题：5 阶段进度条 + 步骤指示器，用户实时看到 AI 在做什么
- 解决"不丰满"问题：多步 LLM 调用，每步专注一方面，角色有 8 个深度字段，世界观有 7 个维度
- 适合 200w 字长篇：角色有成长弧线和秘密可作为伏笔，世界观有势力和规则支撑后续剧情
- 文件变更：
  - 重写 src/lib/novel/agents/outline-parser.ts（5 阶段流水线）
  - 重写 src/app/api/projects/from-outline/route.ts（SSE 流式）
  - 扩展 src/lib/novel/types.ts（+WorldLore, +角色深度字段）
  - 重写 src/components/novel/setup-panel.tsx（SSE 进度 UI）
  - 修改 src/components/novel/live-view.tsx（角色档案展开 + 世界观面板）
- 截图：/home/z/my-project/download/novelstudio-rich-characters.png
