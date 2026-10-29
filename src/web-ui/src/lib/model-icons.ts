/**
 * 厂商图标 → Vite 资源 URL。
 *
 * 图标来自 `C:\\Users\\Administrator\\Downloads\\icons`（大模型厂商官方 logo），
 * 已移入 `src/web-ui/src/assets/models/`，由 Vite 打包成带 hash 的静态资源。
 */
import claude from '@/assets/models/claude-color.svg';
import deepseek from '@/assets/models/deepseek-color.svg';
import doubao from '@/assets/models/doubao-color.svg';
import gemini from '@/assets/models/gemini-color.svg';
import grok from '@/assets/models/grok.svg';
import hunyuan from '@/assets/models/hunyuan-color.svg';
import kimi from '@/assets/models/kimi-color.svg';
import minimax from '@/assets/models/minimax-color.svg';
import muse from '@/assets/models/muse-color.svg';
import openai from '@/assets/models/openai.svg';
import qwen from '@/assets/models/qwen-color.svg';
import xiaomimimo from '@/assets/models/xiaomimimo.svg';
import zai from '@/assets/models/zai.svg';
import type { ModelBrand } from '@/lib/model-brand';

export const MODEL_ICON_SRC: Record<ModelBrand, string> = {
  claude,
  openai,
  gemini,
  grok,
  deepseek,
  qwen,
  kimi,
  zai,
  doubao,
  hunyuan,
  minimax,
  xiaomimimo,
  muse,
};
