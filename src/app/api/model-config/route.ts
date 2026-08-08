import { NextRequest, NextResponse } from 'next/server';
import {
  getModelConfigStatus,
  saveModelConfig,
  type ModelConfig,
} from '@/lib/novel/model-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await getModelConfigStatus();
  return NextResponse.json(status);
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const status = await saveModelConfig(body as Partial<ModelConfig>);
    return NextResponse.json(status);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? '保存模型配置失败' },
      { status: 400 }
    );
  }
}
