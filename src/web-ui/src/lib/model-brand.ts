/**
 * 模型 → 厂商品牌 → 本地图标。
 *
 * 模型与厂商的对应关系取自 models.dev：
 *   - https://models.dev/api.json            提供 provider → models[]，每个模型带 family
 *     （claude-sonnet / gpt-image / gemini-flash / deepseek-thinking / glm / kimi-k2 /
 *      qwen / seed / hunyuan / minimax / mimo / grok / muse）。
 *   - https://models.dev/models.json?type=all 是扁平模型表，只有 id/name，没有厂商字段。
 *
 * 面板拿到的是 provider id、模型 id 与展示名，没有厂商字段，因此这里把上述 family
 * 与厂商 id 归纳成词元规则：先看模型 id，再看展示名，最后才看 provider id。
 * 先看模型名的原因是聚合商（aicode、openrouter、requesty…）会用自家 provider 托管别家模型，
 * 例如 provider=aicode 而 model=claude-sonnet-5-5 应显示 Claude 图标。
 */
export type ModelBrand =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'grok'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'zai'
  | 'doubao'
  | 'hunyuan'
  | 'minimax'
  | 'xiaomimimo'
  | 'muse';

export interface ModelBrandMeta {
  /** 图标的 alt / title 文本 */
  label: string;
  /** src/web-ui/src/assets/models/ 下的文件名 */
  file: string;
}

export const MODEL_BRANDS: Record<ModelBrand, ModelBrandMeta> = {
  claude: { label: 'Anthropic Claude', file: 'claude-color.svg' },
  openai: { label: 'OpenAI', file: 'openai.svg' },
  gemini: { label: 'Google Gemini', file: 'gemini-color.svg' },
  grok: { label: 'xAI Grok', file: 'grok.svg' },
  deepseek: { label: 'DeepSeek', file: 'deepseek-color.svg' },
  qwen: { label: '阿里通义 Qwen', file: 'qwen-color.svg' },
  kimi: { label: '月之暗面 Kimi', file: 'kimi-color.svg' },
  zai: { label: '智谱 GLM', file: 'zai.svg' },
  doubao: { label: '字节豆包 Doubao', file: 'doubao-color.svg' },
  hunyuan: { label: '腾讯混元 Hunyuan', file: 'hunyuan-color.svg' },
  minimax: { label: 'MiniMax', file: 'minimax-color.svg' },
  xiaomimimo: { label: '小米 MiMo', file: 'xiaomimimo.svg' },
  muse: { label: 'Muse', file: 'muse-color.svg' },
};

interface BrandRule {
  brand: ModelBrand;
  /** 命中任一 token（前缀匹配）即认作该品牌 */
  tokens: string[];
  /** 额外正则（针对 o1/o3 这类没有语义前缀的模型） */
  pattern?: RegExp;
}

// 顺序即优先级：先认更具体的厂商，再认可能被聚合商复用的通用词。
const BRAND_RULES: BrandRule[] = [
  { brand: 'claude', tokens: ['claude', 'anthropic'] },
  { brand: 'openai', tokens: ['openai', 'gpt', 'chatgpt', 'davinci', 'codex'], pattern: /^o\d+$/ },
  { brand: 'gemini', tokens: ['gemini', 'gemma', 'palm', 'google', 'vertex'] },
  { brand: 'grok', tokens: ['grok', 'xai'] },
  { brand: 'deepseek', tokens: ['deepseek'] },
  { brand: 'qwen', tokens: ['qwen', 'qwq', 'tongyi', 'alibaba'] },
  { brand: 'kimi', tokens: ['kimi', 'moonshot'] },
  { brand: 'zai', tokens: ['glm', 'chatglm', 'zhipu', 'zai'] },
  { brand: 'doubao', tokens: ['doubao', 'volcengine', 'bytedance', 'seed'] },
  { brand: 'hunyuan', tokens: ['hunyuan', 'tencent'] },
  { brand: 'minimax', tokens: ['minimax', 'abab'] },
  { brand: 'xiaomimimo', tokens: ['mimo', 'xiaomi'] },
  { brand: 'muse', tokens: ['muse'] },
];

// provider id 里常见的连字符写法先归一，例如 z-ai / x-ai / moonshotai
const PROVIDER_ALIASES: Array<[RegExp, string]> = [
  [/z[-_]ai/g, 'zai'],
  [/x[-_]ai/g, 'xai'],
  [/zhipu[-_]?ai/g, 'zhipu'],
  [/moonshot[-_]?ai/g, 'moonshot'],
];

function tokensOf(value?: string | null): string[] {
  let normalized = (value || '').toLowerCase();
  for (const [pattern, replacement] of PROVIDER_ALIASES) normalized = normalized.replace(pattern, replacement);
  return normalized
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function matchTokens(tokens: string[]): ModelBrand | null {
  if (!tokens.length) return null;
  for (const rule of BRAND_RULES) {
    if (rule.pattern && tokens.some((token) => rule.pattern!.test(token))) return rule.brand;
    if (rule.tokens.some((needle) => tokens.some((token) => token === needle || token.startsWith(needle)))) {
      return rule.brand;
    }
  }
  return null;
}

/**
 * 依据模型 id、展示名、provider id 推断品牌；识别不出时返回 null（不渲染图标）。
 * 三个入参都可以为空，按 model → name → provider 的顺序依次尝试。
 */
export function brandOfModel(
  model?: string | null,
  name?: string | null,
  provider?: string | null,
): ModelBrand | null {
  for (const value of [model, name, provider]) {
    const brand = matchTokens(tokensOf(value));
    if (brand) return brand;
  }
  return null;
}

/** provider 分组头用：只看 provider（聚合商没有自家图标时不显示，而不是借用第一个模型的） */
export function brandOfProvider(provider?: string | null): ModelBrand | null {
  return matchTokens(tokensOf(provider));
}
