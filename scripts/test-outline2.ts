import { parseOutline } from '../src/lib/novel/agents/outline-parser';

async function main() {
  // 测试非常短的大纲
  const outline = '修仙少年寻找失散师兄';
  try {
    const result = await parseOutline(outline);
    console.log('=== 短大纲解析成功 ===');
    console.log('characters:', result.characters.length);
    console.log('plotNodes:', result.plotNodes.length);
  } catch (err: any) {
    console.error('=== 短大纲解析失败 ===');
    console.error('error:', err.message);
  }
}
main();
