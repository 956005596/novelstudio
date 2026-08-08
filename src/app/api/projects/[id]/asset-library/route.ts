/**
 * PUT /api/projects/[id]/asset-library
 * 保存创作资产库：天赋、职业、技能、装备、宠物/坐骑、副本、掉落、势力、伏笔。
 */

import { NextRequest, NextResponse } from 'next/server';
import { WorldManager } from '@/lib/novel/world-state';
import { toLLMUserMessage } from '@/lib/novel/llm';
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

function stringList(value: unknown, limit = 8): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit)
    : [];
}

function normalizeGrade(category: NovelAssetCategory, value: unknown): string {
  const grade = String(value ?? '').trim();
  if (category !== 'talent') return grade;
  return grade.toUpperCase();
}

function sanitizeAsset(item: any, index: number): NovelAsset | null {
  const name = String(item?.name ?? '').trim();
  if (!name) return null;
  const category = categories.includes(item?.category) ? item.category as NovelAssetCategory : 'foreshadow';
  const status = statuses.includes(item?.status) ? item.status as NovelAssetStatus : 'concept';
  const chapterNo = Number.isFinite(Number(item?.chapterNo)) && Number(item.chapterNo) > 0
    ? Math.floor(Number(item.chapterNo))
    : null;

  return {
    id: String(item?.id ?? '').trim() || `asset-${Date.now()}-${index}`,
    name,
    category,
    status,
    grade: normalizeGrade(category, item?.grade),
    summary: String(item?.summary ?? '').trim(),
    plotUse: String(item?.plotUse ?? '').trim(),
    mechanics: String(item?.mechanics ?? '').trim(),
    triggerConditions: stringList(item?.triggerConditions, 8),
    rules: stringList(item?.rules, 8),
    linkedCharacters: stringList(item?.linkedCharacters, 8),
    chapterNo,
    source: item?.source === 'agent' || item?.source === 'imported' ? item.source : 'user',
    updatedAt: String(item?.updatedAt ?? '').trim() || new Date().toISOString(),
  };
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const assets = Array.isArray(body.assets)
    ? body.assets.map(sanitizeAsset).filter(Boolean).slice(0, 300) as NovelAsset[]
    : [];

  try {
    const wm = new WorldManager(id);
    const next = await wm.applyWorldPatch({
      assetLibrary: assets,
      storyDesign: undefined,
    });
    return NextResponse.json({ ok: true, worldState: next, assets });
  } catch (err) {
    return NextResponse.json({ error: toLLMUserMessage(err) }, { status: 500 });
  }
}
