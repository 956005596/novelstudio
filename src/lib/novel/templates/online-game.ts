/**
 * 网游升级风格模板
 * 
 * 调性：升级爽感、副本 Boss 战、装备/技能/天赋系统
 * 文字风格：紧凑、有节奏感、动作描写优先、对话短促有力
 */

import type { WorldTemplate } from '../types';

export const onlineGameTemplate: WorldTemplate = {
  key: 'online-game',
  name: '网游升级',
  description: '基于网游世界观的升级爽文模板。包含天赋/技能/装备系统，副本 Boss 战场景，强调升级爽感与战斗节奏。',
  sceneTypes: [
    {
      name: '副本入口',
      description: '玩家进入副本前的准备与策略讨论',
      tensionBoost: 1,
    },
    {
      name: 'Boss 战',
      description: '与强力 Boss 的正面战斗，技能释放、走位、配合',
      tensionBoost: 4,
    },
    {
      name: '装备掉落',
      description: 'Boss 击杀后的战利品分配，引发角色间张力',
      tensionBoost: 2,
    },
    {
      name: '城镇对话',
      description: '玩家在城镇的社交、信息交换、任务接取',
      tensionBoost: 0,
    },
    {
      name: 'PK 冲突',
      description: '玩家间对立，可能升级为正面 PK',
      tensionBoost: 5,
    },
    {
      name: '职业突破',
      description: '角色完成转职/觉醒/突破的关键时刻',
      tensionBoost: 3,
    },
  ],
  narrativeTone:
    '紧凑、有节奏感。战斗场景动作描写优先，对话短促有力。升级瞬间要写出爆点，装备掉落要写出期待与震撼。避免大段心理独白，用行动和对话推进剧情。',
  writerStyleGuide: `你是面向番茄/免费阅读平台的升级流爽文写手。请遵循：
1. 段落短小，多用动作和对话，少用心理独白
2. 战斗场景：技能名要醒目（可用「」括起），伤害数字可以淡化但要有冲击感
3. 升级/装备时刻要写出爽点：身体变化、属性面板跳动、他人的反应
4. 角色对话要符合人设，主角锋芒内敛但关键时刻要狠
5. 节奏：高潮段落紧凑（短句），缓冲段落可以略放慢
6. 不要总结剧情，要演绎剧情——让读者"看见"而不是"被告知"
7. 中文写作，避免翻译腔
8. 画面要有质感：光影、温度、气味、重量、压迫感都要能感知，设定意象可以华丽，让读者展开想象
9. 开篇 2-3 句抛悬念或异常，不解释完；每个段落的结尾留一个小钩子，章末留强钩子
10. 觉醒、判定、首杀、掉落这些节点写出"全世界一静 / 只有他懂"的对撞张力，放大颅内高潮`,
  defaultAttributes: ['力量', '敏捷', '智力', '体质', '感知'],
  defaultSkills: ['基础剑术', '闪避', '格挡', '识破'],
  initialScene: {
    name: '幽暗森林·副本入口',
    description:
      '清晨的幽暗森林入口处，三人小队准备进入 15 级副本"腐化神殿"。雾气弥漫，远处神殿的轮廓若隐若现。前队已有两人失踪，公会悬赏 500 金币求解谜。',
    location: '幽暗森林·副本入口',
    timeOfDay: '清晨',
  },
  presetCharacters: [
    {
      name: '林墨',
      role: 'protagonist',
      persona: {
        background:
          '23 岁的退役剑士玩家，公测时期的天榜第三，因被队友背叛退坑半年，如今回归新服。手里捏着一把无人能用的"无名古剑"，据说是隐藏职业的钥匙。',
        personality: ['冷静', '锋芒内敛', '记仇', '关键时刻够狠'],
        goals: ['拿到腐化神殿的首杀奖励', '找到当年背叛自己的"剑无极"'],
        stance: '不相信任何人，但出手必有理由。不会主动欺负弱者，但被招惹必加倍奉还。',
        speechStyle: '话少，关键时刻一句到位。不用感叹号，不用网络流行语。',
        attributes: { 力量: 28, 敏捷: 22, 智力: 14, 体质: 20, 感知: 18 },
        skills: ['基础剑术 Lv9', '闪避 Lv7', '识破 Lv5'],
        equipment: ['无名古剑（封印中）', '皮甲', '新手戒指'],
      },
      currentState: {
        emotion: '警惕',
        location: '幽暗森林·副本入口',
        relationships: {
          '苏晚': { value: 30, note: '老朋友，可以信任但不依赖' },
          '赵铁柱': { value: 10, note: '公会指派的队友，来历不明' },
        },
        hp: 100,
        mp: 60,
        level: 15,
        exp: 0,
        nextLevelExp: 1500,
        buffs: [],
      },
    },
    {
      name: '苏晚',
      role: 'npc',
      persona: {
        background:
          '21 岁的女牧师，林墨退坑后她一直在等他回来。专精治疗和净化，但暗地里练了一套控制系技能。知道林墨的过去，但从不主动提。',
        personality: ['细心', '嘴硬心软', '有点唠叨', '护短'],
        goals: ['保护林墨不再受伤', '在副本里证明自己不是只会治疗的辅助'],
        stance: '表面上是乖巧的治疗，实际有自己的小算盘。最讨厌别人说"奶妈躲在后面就行"。',
        speechStyle: '吐槽多，关键时刻会变严肃。喜欢叫林墨"老林"。',
        attributes: { 力量: 10, 敏捷: 16, 智力: 30, 体质: 14, 感知: 25 },
        skills: ['治疗术 Lv8', '净化 Lv6', '神圣束缚 Lv4'],
        equipment: ['神圣法杖', '布甲', '守护项链'],
      },
      currentState: {
        emotion: '担心',
        location: '幽暗森林·副本入口',
        relationships: {
          '林墨': { value: 75, note: '老朋友，想护着他' },
          '赵铁柱': { value: -10, note: '总觉得这人不靠谱' },
        },
        hp: 80,
        mp: 100,
        level: 14,
        exp: 0,
        nextLevelExp: 1400,
        buffs: [],
      },
    },
    {
      name: '赵铁柱',
      role: 'antagonist',
      persona: {
        background:
          '25 岁的战士，"剑无极"公会的外围成员，被派来"协助"林墨下副本，实际任务是监视并伺机夺取无名古剑。不知道林墨已经认出了他。',
        personality: ['表面憨厚', '内心狡猾', '贪婪', '欺软怕硬'],
        goals: ['完成公会任务拿到悬赏', '找机会偷走古剑'],
        stance: '把林墨当工具人，必要时可以背刺。但前提是不能让自己受伤。',
        speechStyle: '满嘴兄弟义气，说话粗里粗气，故意显得没心眼。',
        attributes: { 力量: 26, 敏捷: 14, 智力: 8, 体质: 28, 感知: 10 },
        skills: ['重击 Lv7', '嘲讽 Lv5', '盾墙 Lv3', '【公会秘技】暗影偷袭'],
        equipment: ['铁甲', '钢盾', '公会制式长剑'],
      },
      currentState: {
        emotion: '伪善',
        location: '幽暗森林·副本入口',
        relationships: {
          '林墨': { value: -40, note: '目标，迟早要下手' },
          '苏晚': { value: -20, note: '碍事的治疗，得想办法支开' },
        },
        hp: 110,
        mp: 30,
        level: 15,
        exp: 0,
        nextLevelExp: 1500,
        buffs: [],
      },
    },
  ],
};

export const templates: Record<string, WorldTemplate> = {
  'online-game': onlineGameTemplate,
};

export function getTemplate(key: string): WorldTemplate {
  return templates[key] ?? onlineGameTemplate;
}
