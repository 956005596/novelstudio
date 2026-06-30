import { parseOutline } from '../src/lib/novel/agents/outline-parser';

async function main() {
  const outline = '退役剑士林墨回归新服，被旧仇人公会派来的卧底赵铁柱监视，副本里赵铁柱准备偷袭夺剑，被治疗苏晚识破。三人最终在 Boss 战前摊牌。';
  try {
    const result = await parseOutline(outline);
    console.log('=== 解析成功 ===');
    console.log('templateKey:', result.templateKey);
    console.log('characters:', result.characters.length);
    console.log('plotNodes:', result.plotNodes.length);
    console.log('worldState.sceneName:', result.worldState.sceneName);
    console.log('first character:', JSON.stringify(result.characters[0], null, 2).slice(0, 500));
  } catch (err: any) {
    console.error('=== 解析失败 ===');
    console.error('error:', err.message);
  }
}
main();
