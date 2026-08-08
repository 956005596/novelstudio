/**
 * POST /api/projects/[id]/asset-library/design
 * 让体系策划 Agent 根据当前总纲/细纲生成创作资产候选。
 */

import { NextRequest, NextResponse } from 'next/server';
import { chat, extractJSON, toLLMUserMessage, type ChatMessage } from '@/lib/novel/llm';
import { ensureChapterFocus } from '@/lib/novel/chapter-focus';
import { storyBibleText } from '@/lib/novel/story-bible';
import { WorldManager } from '@/lib/novel/world-state';
import type { NovelAsset, NovelAssetCategory, NovelAssetStatus } from '@/lib/novel/types';

const categories: NovelAssetCategory[] = [
  'talent',
  'profession',
  'skill',
  'equipment',
  'pet_mount',
  'monster_dungeon',
  'drop_resource',
  'faction_location',
  'foreshadow',
];

const statuses: NovelAssetStatus[] = ['concept', 'foreshadow', 'available', 'landed', 'disabled'];
const CATEGORY_TARGET_DEFAULT = 10;
const CATEGORY_TARGET_MAX = 12;
const CATEGORY_OUTPUT_LIMIT = 120;

interface AssetDesignDraft {
  assets?: Array<Partial<NovelAsset>>;
  strategy?: string;
  risks?: string[];
}

function stringValue(value: unknown): string {
  return String(value ?? '').trim();
}

function stringList(value: unknown, limit = 8): string[] {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter(Boolean).slice(0, limit)
    : [];
}

function normalizeGrade(category: NovelAssetCategory, value: unknown): string {
  const grade = stringValue(value);
  if (category !== 'talent') return grade;
  return grade.toUpperCase();
}

function sanitizeAsset(item: Partial<NovelAsset>, index: number): NovelAsset | null {
  const name = stringValue(item.name);
  if (!name) return null;
  const category = categories.includes(item.category as NovelAssetCategory)
    ? item.category as NovelAssetCategory
    : 'foreshadow';
  const status = statuses.includes(item.status as NovelAssetStatus)
    ? item.status as NovelAssetStatus
    : 'concept';
  const rawChapterNo = Number(item.chapterNo);
  const nextChapterNo = Number.isFinite(rawChapterNo) && rawChapterNo > 0
    ? Math.floor(rawChapterNo)
    : null;

  return {
    id: `asset-agent-${Date.now()}-${index}`,
    name,
    category,
    status,
    grade: normalizeGrade(category, item.grade),
    summary: stringValue(item.summary),
    plotUse: stringValue(item.plotUse),
    mechanics: stringValue(item.mechanics),
    triggerConditions: stringList(item.triggerConditions, 8),
    rules: stringList(item.rules, 8),
    linkedCharacters: stringList(item.linkedCharacters, 8),
    chapterNo: nextChapterNo,
    source: 'agent',
    updatedAt: new Date().toISOString(),
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const request = stringValue(body.request) || '请为当前长篇网游/深渊降临小说设计一批可支撑长期剧情的体系素材。';
  const targetPerCategory = Math.max(
    4,
    Math.min(CATEGORY_TARGET_MAX, Math.floor(Number(body.targetPerCategory) || CATEGORY_TARGET_DEFAULT))
  );

  try {
    const wm = new WorldManager(id);
    const { worldState, characters } = await wm.loadProject();
    const focused = ensureChapterFocus(worldState);
    const chapter = focused.currentChapter;
    const bibleInfo = storyBibleText(focused, { futureNodeLimit: 14 });
    const existingAssets = focused.assetLibrary ?? [];

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是 NovelStudio 的“体系策划 Agent”，专门为长篇网游/深渊降临小说设计创作资产库。

目标：设计天赋、职业、技能、装备、宠物/坐骑、怪物/副本、掉落/资源、势力/地点、伏笔，让剧情更爽、更有可玩性、更有拓展性，但不能破坏当前章节逻辑。

你的审美要求：先像一个正经网游系统策划，再像爽文编辑。素材必须服务“升级、打怪、掉落、转职、Build、组队分工、副本机制、资源争夺、战力成长”的玩法闭环。奇观只能作为加分项，不能替代可玩性。每个素材都要回答：它给玩家什么打法、什么成长路线、什么争夺点、什么剧情冲突。

硬性纪律：
1. 不要直接改正文，不要说你会改代码。你只输出素材候选。
2. 素材必须分类，category 只能是：
   talent, profession, skill, equipment, pet_mount, monster_dungeon, drop_resource, faction_location, foreshadow
3. 状态 status 只能是：
   concept=概念库，只作长期灵感；
   foreshadow=可伏笔，只能埋线索；
   available=剧情可调度，可以被导演在合适剧情触发时调用，但不能强制绑定某章；
   landed=已落地，只有当前正稿明确写过才能用；
   disabled=禁用。
4. 第一章/早期章节不要发放过强装备、技能、宠物；可以设计强概念，但状态应是 concept 或 foreshadow。
5. 不要把“主角无天赋”直接解释成终极外挂；早期只能给异常感、压迫感、误判空间。
6. grade 规则必须按类别区分：
   - 天赋 talent 使用独立天赋品阶：SSS, SS, S, A, B, C, D, E, F。不要给天赋写白板/黑铁/终焉。
   - 职业、技能、装备、宠物/坐骑、怪物/副本、掉落/资源、势力/地点、伏笔使用本书 11 阶品阶体系，且要符合该阶命题：
   1 白板=存在：只有基础功能，没有来历和特效。
   2 黑铁=可靠：稳定、耐用、低维护，陪伴新手期。
   3 白银=专精：第一条明确特效，开始按场景配装。
   4 黄金=成名：真名、全服公告、双特效联动，玩家第一次被世界看见。
   5 暗金=秘密：隐藏词条和未完成描述，触发条件本身是谜题。
   6 钻石=创造：机制型特效，改写局部玩法逻辑而非只加数值。
   7 传说=传承：历任持有者、记忆/遗愿/留言、继承技能。
   8 神话=自主：物品有意志倾向，会认可、沉默、护主或反噬。
   9 禁断=代价：规则级效果和明确代价，世界会试图封印它。
   10 劫灭=终局：一次性或超长周期终局能力，会改变世界格局。
   11 终焉=重启：悖论级存在，无官方机制说明，出现意味着新版本/新篇章。
   品阶写作范式：同一把“短剑”在白板阶只证明“这是一把剑”；黑铁阶体现守卫营老兵用了十年仍可靠；白银阶拥有夜巡等单一场景特效；黄金阶因审判故事获得真名和全服公告；暗金阶藏着未完成文字和未知触发；钻石阶改写命中规则；传说阶承载历任持有者；神话阶有自己的意志；禁断阶以说谎改写事实但付出无法说真话的代价；劫灭阶能终结一场战争；终焉阶像未完的最后一个字，只留下关于结局的疑问。生成素材时必须写出“为何它属于这一阶”，而不是只填品级名。
   天赋品阶范式：
   - F/E/D：低阶但可玩，提供生活化、侦测、微弱增益或副作用，适合误判、反差和小聪明。
   - C/B/A：形成明确打法、职业适配或团队位置，能改变一场战斗的选择。
   - S/SS：罕见强天赋，带来成长线、组织争夺、资源倾斜和社会压力，必须有限制或代价。
   - SSS：规则级唯一/近唯一天赋，不等于开局无敌；必须有误判、封印、代价、阶段解锁或强触发条件。
7. 设计要天马行空，但每个素材必须有机制文本 mechanics 和规则限制，避免变成万能设定。
   - 普通玩家等级为 Lv1-Lv999；Lv1-Lv9 没有职业，只能设计觉醒判定、天赋误判、基础属性、临时技能现象和低阶掉落。第一个玩家达到 Lv10 后才触发世界改革，职业、复活祭坛、世界公告、首杀奖励、世界 Boss、版图扩张和未知区域开始降临。
   - 大部分玩家受限于天赋、职业上限、资源和成长曲线，会长期困在 Lv100 以内的蓝星世界；少数突破 Lv100 的人才逐步进入深渊视野。深渊也在无时无刻入侵蓝星，素材要能体现裂隙、污染区、怪物潮、世界 Boss 投影、异常地貌和规则侵蚀。
   - Lv999 是普通玩家天花板，不是世界力量天花板。主角团后续会通过王权、终焉器和十三层深渊试炼破限；第九层开始 Boss 可接近/达到 Lv999，第十三层可出现 Lv4000+ 的恐怖存在。设计高层深渊素材时要体现这种数值压迫，但不能让早期素材越界。
   - 禁止用“残响、回响、低语、呢喃、余烬、旧影、权限、密钥、日志”这类空泛或程序员味词当素材核心。除非它明确对应游戏内承载物，例如王座铭文、权柄印记、神话断章、封印钥印、技能余波、能量残留、背叛证据、游戏公告、首杀战报、掉落材料、异常状态或任务线索。
   - 职业必须像网游职业：要有战斗定位（坦克/输出/治疗/控制/召唤/刺杀/辅助/生产/指挥）、主属性、核心资源、技能循环、转职分支、克制关系和团队价值。不要把“公告撰写者、失物招领员、辩护士、注销员”这类行政/概念身份当主职业；它们最多是副职业、称号、NPC职能或伏笔。
   - 装备必须像用户给的“逆命之弦”案例：有具体部位/武器类型、背景意象、核心机制名、主动效果、被动效果或触发条件、引爆/结算方式、冷却/代价、适配职业/打法、掉落来源。不要写“粉笔、拖把、校牌”这种低意义日用品，除非它被设计成明确可用的武器/饰品机制并能改变战斗。
   - 技能/天赋要写清：核心机制、主动/被动效果、触发/引爆/成长方式、代价或冷却。
   - 怪物/副本不是血条，不要只写“高攻高防”。必须写清：机制谜题、破解条件、团队矛盾或社交压力、掉落反馈。
   - 数值可以写成节奏草案，例如“治疗量300%/真实伤害500%”，后续会根据剧情节奏调整，不要因为怕平衡就写得无聊。
   - 必须做品阶审校：如果机制越阶，要么提高 grade，要么削弱机制、增加代价/触发难度/使用窗口。白银不能写钻石级规则改写，钻石不能无代价触碰禁断规则，禁断不能随手做到劫灭/终焉级世界重启。
   - 允许写“雏形/待定”，例如“白银/钻石雏形”，但必须说明当前阶段只开放哪一部分机制，高阶部分何时才解锁。
   - 机制范式示例：名称“逆命之弦（长弓）”；背景“由命运女神断裂的琴弦编织，弓臂刻有倒流钟表纹”；核心机制【因果倒置】；主动效果“标记敌人5秒，期间下一次对目标伤害逆转为等量治疗，并吸收治疗量形成因果箭矢”；引爆“标记结束或再次激活时，对目标造成吸收治疗量倍率的真实伤害”。请学习这种“背景意象 + 核心机制 + 主动效果 + 引爆/代价”的颗粒度，不要照抄。
   - 怪物范式示例：名称“贪念聚合体（世界BOSS）”；外观“金币、武器、铠甲碎片组成的巨大漩涡，中央独眼”；核心机制【欲壑难填】复制在场玩家背包中市场价值最高的物品并获得其特效；【镜像弱点】必须由被复制装备的玩家用原装备打出有效攻击才露出核心；掉落奖励包括复制物品的限时投影。请学习这种“怪物本身就是谜题 + 炫富/责任/保护关键玩家的戏剧性”的设计，不要照抄。
8. 不要强制绑定章节和人物。chapterNo 只能作为“参考阶段”，linkedCharacters 只能作为“可能牵涉对象”；真正什么时候出现由剧情相遇、觉醒检测、战斗、交易、任务、掉落、误判等触发决定。
9. 本次请按类别尽量补齐配额：每个 category 目标约 ${targetPerCategory} 个。已有素材可以算作基础，但新输出仍要尽量覆盖短缺类别，不要只生成装备或伏笔。
10. 输出 JSON，不要 markdown。

JSON 结构：
{
  "strategy": "素材库整体设计思路",
  "assets": [
    {
      "name": "素材名",
      "category": "talent",
      "status": "concept",
      "grade": "天赋用 SSS-F；其他用白板-终焉",
      "summary": "设定摘要",
      "plotUse": "它如何服务升级、打怪、掉落、转职、Build、组队、副本或资源争夺",
      "mechanics": "职业写定位/主属性/核心资源/技能循环/转职；装备写部位/核心机制/主动被动/引爆结算/冷却代价/适配打法；怪物写破解条件和掉落反馈",
      "triggerConditions": ["什么剧情条件下才可以出现或被描写"],
      "rules": ["规则/限制"],
      "linkedCharacters": ["可能牵涉对象，可为空"],
      "chapterNo": null
    }
  ],
  "risks": ["使用风险"]
}`,
      },
      {
        role: 'user',
        content: `# 用户本次素材设计要求
${request}

# 当前创作圣经
${bibleInfo}

# 当前章
${chapter ? `第${chapter.chapterNo}章《${chapter.title}》
目标：${chapter.goal}
范围：${chapter.scope}
节拍：
${chapter.beats.map((beat, index) => `${index + 1}. ${beat}`).join('\n')}
护栏：
${chapter.constraints.map((item) => `- ${item}`).join('\n')}` : '无当前章'}

# 当前剧情节点
${focused.plotNodes?.slice(0, 40).map((node) => `节点${node.index} [${node.nodeType ?? 'stage'}] ${node.title}：${node.description}；completed=${node.completed}`).join('\n') || '- 无'}

# 角色
${characters.map((character) => `- ${character.name}：性别=${character.persona.gender ?? '未记录'}；职业=${character.persona.profession ?? '无'}；天赋=${character.persona.talents?.join('、') || '无'}；技能=${character.persona.skills?.join('、') || '无'}；背景=${character.persona.background ?? '-'}`).join('\n') || '- 无'}

# 已有素材
${existingAssets.length ? existingAssets.map((asset) => `- ${asset.name} [${asset.category}/${asset.status}]：${asset.summary}`).join('\n') : '- 无'}

# 任务
请补充素材候选，目标是让每个类别最终接近 ${targetPerCategory} 个：天赋、职业、技能、装备、宠物/坐骑、怪物/副本、掉落/资源、势力/地点、伏笔。
如果输出长度有限，优先补短缺类别；但本轮请尽量输出 60-90 个候选。早期可调度素材要少而精准，长期素材要炫酷但保持“概念/可伏笔”边界。不要把素材强行安排到当前章或某个固定角色身上。`,
      },
    ];

    const raw = await chat(messages, { temperature: 0.86, maxTokens: 12000 });
    const parsed = extractJSON<AssetDesignDraft>(raw);
    if (!parsed?.assets?.length) throw new Error('素材设计结果解析失败');
    const assets = parsed.assets
      .map((asset, index) => sanitizeAsset(asset, index))
      .filter(Boolean)
      .slice(0, CATEGORY_OUTPUT_LIMIT) as NovelAsset[];

    return NextResponse.json({
      ok: true,
      strategy: stringValue(parsed.strategy),
      risks: stringList(parsed.risks, 8),
      assets,
    });
  } catch (err) {
    return NextResponse.json({ error: toLLMUserMessage(err) }, { status: 500 });
  }
}
