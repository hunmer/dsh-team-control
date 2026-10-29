import type { ReactNode } from 'react';
import { MODEL_BRANDS, brandOfModel, brandOfProvider, type ModelBrand } from '@/lib/model-brand';
import { MODEL_ICON_SRC } from '@/lib/model-icons';

export interface ModelAvatarProps {
  /** API 里的模型 id，如 claude-sonnet-5-5 */
  model?: string | null;
  /** 展示名，部分目录只有 name 能看出厂商 */
  name?: string | null;
  /** provider id，作为 model/name 都识别不出时的兜底 */
  provider?: string | null;
  /** 像素尺寸，默认 16 */
  size?: number;
  className?: string;
}

function BrandIcon({ brand, size, className, title }: { brand: ModelBrand; size: number; className?: string; title?: string }) {
  const meta = MODEL_BRANDS[brand];
  return (
    <img
      src={MODEL_ICON_SRC[brand]}
      alt=""
      title={title ?? meta.label}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      draggable={false}
      className={className}
    />
  );
}

/** 模型行 / 成员标记用的厂商图标；识别不出品牌时不渲染（而不是给一个通用占位） */
export function ModelAvatar({ model, name, provider, size = 16, className }: ModelAvatarProps) {
  const brand = brandOfModel(model, name, provider);
  if (!brand) return null;
  return <BrandIcon brand={brand} size={size} className={className ?? 'shrink-0 select-none object-contain'} />;
}

/** provider 分组头用：只按 provider 匹配，聚合商（aicode 等）不借用模型的图标 */
export function ProviderAvatar({ provider, size = 16, className }: { provider?: string | null; size?: number; className?: string }) {
  const brand = brandOfProvider(provider);
  if (!brand) return null;
  return <BrandIcon brand={brand} size={size} className={className ?? 'shrink-0 select-none object-contain'} />;
}

/** 给 agent-lanes / agent-tree 的 `avatar` 插槽用：没有品牌时返回 undefined，组件会退回首字母 */
export function modelAvatar(model?: string | null, name?: string | null, provider?: string | null, size = 15): ReactNode {
  const brand = brandOfModel(model, name, provider);
  if (!brand) return undefined;
  return <BrandIcon brand={brand} size={size} />;
}
