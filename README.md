# NovelStudio — AI 演绎叙事引擎

> 多智能体（Multi-Agent）自主演绎的小说创作引擎：从一句话大纲到完整正文，导演（Director）调度、角色（Character）第一人称演绎、写手（Writer）流式成文，辅以读者反馈与连续性审校，形成闭环创作流程。

## ✨ 核心特性

- **大纲驱动**：输入任意粒度大纲（一句话 / 多段 / 章节级），AI 自动解析为风格模板、世界观设定、角色（含 persona 与关系网）与剧情节点（plotNodes）
- **多 Agent 自主演绎**：导演决策 → 角色第一人称提案 → 仲裁 → 写入事件日志 → 更新 World State → 写手流式生成正文
- **编导圆桌（Roundtable）**：多个角色围绕当前剧情节点参与讨论，产生更丰富的叙事走向
- **世界认知模块（buildWorldContext）**：所有 Agent 共享"此刻世界状态"，保证演绎过程中的一致性
- **连续性审校（Continuity Auditor）**：自动检查前后设定、角色状态、时间线的一致性
- **读者反馈（Readers）**：读者视角审读章节，驱动修订与重写
- **角色演绎系统**：代入式提示词、身体状态连续性、导演放权模式、JSON 强制输出
- **可配置角色温度**：全局 `actorTemperature` + 角色级 `actingTemperature`（0.4–1.2），在保持连续性的前提下调节角色多样性
- **番茄流强钩子写作**：章节节奏锚点控制，支撑长篇幅网文创作
- **章节聚焦与追踪**：自动生成章节标题与创作重点，支持章节重置 / 清理
- **实时流式输出**：SSE 流式正文 + Socket.IO 双向控制（启动 / 暂停 / 继续 / 停止）
- **干预机制**：导演指令、世界编辑、角色编辑、章节重写，全流程可人工介入
- **设定中心（Story Bible）**：项目级设定圣经，支持同步与备注
- **资产库**：角色形象设计等创作资产管理
- **导出**：章节正文导出为 Markdown

## 🏗️ 架构

```
                    ┌─────────────────────────────────────────┐
                    │             World State（共享黑板）         │
                    │   事件日志（不可变追加）+ 世界/角色状态快照     │
                    └──────────────┬──────────────────────────┘
                                   │
   大纲 ──► Outline Parser ──► 风格/世界观/角色/剧情节点
                                   │
                    ┌──────────────▼──────────────────────────┐
                    │              Director（导演）              │
                    │  决策：谁行动 / 注入事件 / 触发写手 / 张力调整  │
                    │  仲裁：解决多角色提案冲突                     │
                    └──────────────┬──────────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────────┐
                    │        Character（角色 Agent）            │
                    │  第一人称行为提案，符合 persona 与目标       │
                    └──────────────┬──────────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────────┐
                    │            Writer（写手）                 │
                    │  事件日志 ─► 小说正文（流式，风格锚点）       │
                    └─────────────────────────────────────────┘
                                   │
                Readers（读者反馈）◄─┘──► Continuity Auditor（连续性审校）
```

**Agent 清单**（`src/lib/novel/agents/`）：

| Agent | 职责 |
|---|---|
| `outline-parser` | 任意粒度大纲 → 风格 / 世界观 / 角色 / 剧情节点 |
| `director` | 演绎调度与冲突仲裁，读取剧情节点作为骨架 |
| `character` | 第一人称角色演绎，代入式提示词 + 身体状态连续性 |
| `writer` | 事件日志 → 正文，流式输出，风格锚点 |
| `readers` | 读者视角章节反馈 |
| `continuity-auditor` | 设定 / 状态 / 时间线一致性审校 |
| `story-designer` | 故事设计辅助 |
| `character-archivist` | 角色档案维护 |

## 🛠️ 技术栈

- **前端**：Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui · Zustand
- **数据**：Prisma + SQLite
- **实时引擎**：Socket.IO（Bun 运行，独立 mini-service，端口 3003）
- **LLM**：OpenAI 兼容接口（支持 Chat Completions 与 Responses API），内置 429/5xx 指数退避重试

## 🚀 快速开始

### 环境要求

- Node.js ≥ 20
- [Bun](https://bun.sh)（运行小说引擎 mini-service）

### 安装与配置

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（.env）
DATABASE_URL="file:./dev.db"   # SQLite 路径按需调整

# 3. 初始化数据库
npm run db:push

# 4. 配置模型（二选一）
#    a) 创建 .z-ai-config（项目根目录或用户主目录）：
#       { "baseUrl": "https://api.example.com/v1", "apiKey": "sk-xxx" }
#    b) 启动后在 UI 的模型配置页填写
```

### 启动

```bash
npm run dev
```

- 创作界面（Next.js）：http://localhost:3000
- 演绎引擎（Socket.IO）：端口 3003

> 开发模式下也可以分别运行：`npm run dev:next`（前端）与 `npm run dev:engine`（引擎）。

### 使用流程

1. 创建项目（或直接粘贴大纲，走 `from-outline` 一键解析）
2. 在模型配置页确认模型可用（可点击测试）
3. 进入项目 → 设置导演强度（Director 主导强度 1–5）
4. 启动演绎：导演决策 → 角色演绎 → 写手成文，全程可暂停 / 干预 / 重写
5. 章节完成后触发读者反馈与连续性审校，迭代修订
6. 导出 Markdown

## 📁 项目结构

```
src/
├── app/
│   └── api/
│       ├── projects/            # 项目 CRUD、from-outline、导出、重置…
│       │   └── [id]/
│       │       ├── chapters/    # 章节、重写、canonical、focus、reviews
│       │       ├── characters/  # 角色、prompt-preview
│       │       ├── roundtable/  # 编导圆桌
│       │       ├── asset-library/  # 创作资产
│       │       ├── story-bible-notes/  # 设定中心备注
│       │       └── events/      # 事件日志
│       └── model-config/        # 模型配置（读写 / 测试）
├── components/
│   ├── novel/                   # SetupPanel、LiveView（三栏创作界面）
│   └── ui/                      # shadcn/ui 组件
├── lib/novel/                   # 核心引擎
│   ├── agents/                  # 各 Agent 实现
│   ├── templates/               # 风格模板（online-game 等）
│   ├── engine.ts                # 演绎编排循环
│   ├── world-state.ts           # World State 黑板
│   ├── world-context.ts         # 世界认知模块
│   ├── model-config.ts          # 模型配置读写
│   └── llm.ts                   # OpenAI 兼容 LLM 封装
└── store/novel-store.ts         # Zustand 状态
mini-services/novel-engine/      # Socket.IO 演绎引擎（Bun）
prisma/schema.prisma             # 数据模型
```

## 🗄️ 数据模型（Prisma / SQLite）

| 模型 | 说明 |
|---|---|
| `Project` | 小说项目（一个独立的演绎世界），含 World State 快照、导演强度、状态 |
| `Character` | 角色（主角 / 反派 / NPC），persona、目标、立场 |
| `Chapter` | 章节（正文、turn 区间、状态） |
| `Event` | 事件日志（不可变追加） |
| `Directive` | 导演指令 / 干预指令 |
| `ReaderReview` | 读者审读反馈 |
| `RoundtableEntry` | 编导圆桌记录 |
| `CharacterChapterSnapshot` | 角色跨章节状态快照 |

## 🔗 常用 API

- `POST /api/projects` · `GET /api/projects` · `DELETE /api/projects/[id]`
- `POST /api/projects/from-outline` — 大纲一键解析建项目
- `GET /api/projects/[id]/chapters` · `POST .../chapters/[chapterId]/rewrite` · `.../canonical` · `.../focus`
- `GET /api/projects/[id]/characters` · `POST .../prompt-preview`
- `GET /api/projects/[id]/events` · `POST /api/projects/[id]/roundtable`
- `GET /api/projects/[id]/export` — 导出 Markdown
- `PUT /api/model-config` · `POST /api/model-config/test`

## 📝 许可证

本仓库暂未提供开源许可证（All Rights Reserved）。如需商用或二次分发，请联系作者。

---

> 开发记录见 [`worklog.md`](./worklog.md)。
