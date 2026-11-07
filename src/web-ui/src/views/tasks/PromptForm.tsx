import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Field } from './fields';

/** 提示词增强表单的可编辑字段，序列化后写入任务描述。 */
export interface PromptFormState {
  problem: string;
  acceptance: string;
  time: string;
  git: string;
  tests: string;
  plan: string;
  files: string;
  stack: string;
  constraints: string;
  lang: string;
  notes: string;
}

export const EMPTY_PROMPT_FORM: PromptFormState = {
  problem: '',
  acceptance: '',
  time: '',
  git: '',
  tests: '',
  plan: '',
  files: '',
  stack: '',
  constraints: '',
  lang: '',
  notes: '',
};

const ADVANCED_KEYS = ['plan', 'files', 'stack', 'constraints', 'lang', 'notes'] as const;
const NONE = '\u0000__none__';

const TIME_OPTIONS = [
  { value: '5', label: '5 分钟 · 快速', line: '5 分钟（思考深度：快速）' },
  { value: '15', label: '15 分钟 · 标准', line: '15 分钟（思考深度：标准）' },
  { value: '30', label: '30 分钟 · 深入', line: '30 分钟（思考深度：深入）' },
  { value: '60', label: '1 小时 · 深度', line: '1 小时（思考深度：深度）' },
  { value: '120', label: '2 小时以上 · 极深', line: '2 小时以上（思考深度：极深）' },
] as const;

const GIT_OPTIONS = [
  { value: 'yes', label: '自动提交', line: '完成后自动提交' },
  { value: 'no', label: '不提交', line: '不要提交，保留改动' },
] as const;

const TEST_OPTIONS = [
  { value: 'yes', label: '需要', line: '需要，完成后运行相关测试' },
  { value: 'no', label: '不需要', line: '不需要' },
] as const;

const PLAN_OPTIONS = [
  { value: 'ask', label: '先给方案', line: '先给出简短方案，确认后再动手' },
  { value: 'direct', label: '直接执行', line: '直接执行，无需确认' },
] as const;

const LANG_OPTIONS = [
  { value: 'zh', label: '中文', line: '中文' },
  { value: 'en', label: 'English', line: 'English' },
  { value: 'auto', label: '跟随项目', line: '跟随项目' },
] as const;

const PRESET_KEY = 'dsh-team.prompt-presets.v1';

/** 本地提示词预设：只存表单字段，不绑定具体任务。 */
interface PromptPreset {
  id: string;
  name: string;
  form: PromptFormState;
}

function loadPromptPresets(): PromptPreset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): PromptPreset[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Partial<PromptPreset>;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (!name) return [];
      return [
        {
          id: typeof record.id === 'string' && record.id ? record.id : makePresetId(),
          name,
          form: normalizePromptForm(record.form),
        },
      ];
    });
  } catch {
    return [];
  }
}

function persistPromptPresets(presets: PromptPreset[]) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  } catch {
    /* 存储不可用时静默降级为不记忆 */
  }
}

function makePresetId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function normalizePromptForm(
  form: Partial<PromptFormState> | null | undefined,
): PromptFormState {
  const next: PromptFormState = { ...EMPTY_PROMPT_FORM };
  if (!form) return next;
  for (const key of Object.keys(EMPTY_PROMPT_FORM) as Array<keyof PromptFormState>) {
    const value = form[key];
    if (typeof value === 'string') next[key] = value;
  }
  return next;
}

function hasAdvancedFields(form: PromptFormState): boolean {
  return ADVANCED_KEYS.some((key) => form[key].trim().length > 0);
}

function hasAnyField(form: PromptFormState): boolean {
  return Object.values(form).some((value) => value.trim().length > 0);
}

function lineOf(
  options: readonly { value: string; line: string }[],
  value: string,
): string | null {
  const option = options.find((item) => item.value === value);
  return option ? option.line : null;
}

/** 把表单序列化成任务描述文本；只有问题描述时保持原始纯文本。 */
export function serializePrompt(raw: PromptFormState): string {
  const form = normalizePromptForm(raw);
  const hasExtras = [
    form.acceptance,
    form.time,
    form.git,
    form.tests,
    form.plan,
    form.files,
    form.stack,
    form.constraints,
    form.lang,
    form.notes,
  ].some((value) => value.trim().length > 0);
  if (!hasExtras) return form.problem;

  const sections: string[] = [];

  if (form.problem.trim()) {
    sections.push(`## 问题描述\n\n${form.problem.trim()}`);
  }
  if (form.acceptance.trim()) {
    sections.push(`## 验收标准\n\n${form.acceptance.trim()}`);
  }

  const exec: string[] = [];
  const time = lineOf(TIME_OPTIONS, form.time);
  if (time) exec.push(`- 预期执行时间：${time}`);
  const git = lineOf(GIT_OPTIONS, form.git);
  if (git) exec.push(`- Git：${git}`);
  const tests = lineOf(TEST_OPTIONS, form.tests);
  if (tests) exec.push(`- 自动化测试：${tests}`);
  const plan = lineOf(PLAN_OPTIONS, form.plan);
  if (plan) exec.push(`- 执行方式：${plan}`);
  if (exec.length) sections.push(`## 执行要求\n\n${exec.join('\n')}`);

  const context: string[] = [];
  if (form.files.trim()) context.push(`- 涉及文件/模块：${form.files.trim()}`);
  if (form.stack.trim()) context.push(`- 技术栈/框架：${form.stack.trim()}`);
  if (form.constraints.trim()) context.push(`- 约束与禁止：${form.constraints.trim()}`);
  const lang = lineOf(LANG_OPTIONS, form.lang);
  if (lang) context.push(`- 输出语言：${lang}`);
  const notes = form.notes.trim();
  if (context.length || notes) {
    const body = [context.join('\n'), notes].filter(Boolean).join('\n\n');
    sections.push(`## 补充信息\n\n${body}`);
  }

  if (!sections.length) return form.problem;
  return sections.join('\n\n');
}

type SectionKind = 'problem' | 'acceptance' | 'exec' | 'context';

function matchHeading(title: string): SectionKind | null {
  const text = title.trim().toLowerCase();
  if (text === '问题描述' || text === 'problem' || text === 'problem statement') return 'problem';
  if (text === '验收标准' || text === 'acceptance' || text === 'acceptance criteria') {
    return 'acceptance';
  }
  if (
    text === '执行要求' ||
    text === 'execution requirements' ||
    text === 'execution' ||
    text === 'requirements'
  ) {
    return 'exec';
  }
  if (
    text === '补充信息' ||
    text === 'additional context' ||
    text === 'additional information' ||
    text === 'context'
  ) {
    return 'context';
  }
  return null;
}

type LineKind =
  | 'time'
  | 'git'
  | 'tests'
  | 'plan'
  | 'files'
  | 'stack'
  | 'constraints'
  | 'lang';

function matchLabel(label: string): LineKind | null {
  const text = label.trim().toLowerCase();
  if (/^(预期执行时间|执行时间|time|duration)/.test(text)) return 'time';
  if (/git|提交/.test(text)) return 'git';
  if (/自动化测试|测试|test|testing/.test(text)) return 'tests';
  if (/执行方式|execution (style|mode)|mode/.test(text)) return 'plan';
  if (/涉及文件|文件|files?|scope|模块/.test(text)) return 'files';
  if (/技术栈|框架|stack|tech/.test(text)) return 'stack';
  if (/约束|禁止|constraint|forbidden/.test(text)) return 'constraints';
  if (/输出语言|语言|language|lang/.test(text)) return 'lang';
  return null;
}

function parseTime(value: string): string {
  const hours = /(\d+(?:\.\d+)?)\s*(?:个)?小时/.exec(value);
  if (hours) return Number(hours[1]) >= 2 ? '120' : '60';
  const minutes = /(\d+)\s*(?:分钟|min)/i.exec(value);
  if (!minutes) return '';
  if (minutes[1] === '5' || minutes[1] === '15' || minutes[1] === '30') return minutes[1];
  const numeric = Number(minutes[1]);
  if (numeric <= 5) return '5';
  if (numeric <= 15) return '15';
  if (numeric <= 30) return '30';
  if (numeric <= 60) return '60';
  return '120';
}

function parseTri(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (/(不需要|不要|不提交|无需|不用|否|\bno\b|not)/i.test(text)) return 'no';
  if (/(需要|完成后|自动提交|运行|是|\byes\b)/i.test(text)) return 'yes';
  return '';
}

function parsePlan(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (/直接执行|无需确认|direct/i.test(text)) return 'direct';
  if (/先给|确认后|方案|ask/i.test(text)) return 'ask';
  return '';
}

function parseLang(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (/english/i.test(text)) return 'en';
  if (/跟随项目|auto/i.test(text)) return 'auto';
  if (/中文/.test(text)) return 'zh';
  return '';
}

/** 解析结构化提示词；无法识别时返回 null（调用方按纯文本处理）。 */
export function parsePrompt(text: string): PromptFormState | null {
  if (!text.trim()) return { ...EMPTY_PROMPT_FORM };

  const buffers: Record<SectionKind, string[]> = {
    problem: [],
    acceptance: [],
    exec: [],
    context: [],
  };
  let current: SectionKind | null = null;
  let sawHeading = false;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      sawHeading = true;
      const kind = matchHeading(heading[1]);
      if (!kind) return null;
      current = kind;
      continue;
    }
    if (current) buffers[current].push(line);
  }
  if (!sawHeading) return null;

  const form: PromptFormState = { ...EMPTY_PROMPT_FORM };
  form.problem = buffers.problem.join('\n').trim();
  form.acceptance = buffers.acceptance.join('\n').trim();

  const readEntries = (lines: string[]): Array<[string, string]> => {
    const entries: Array<[string, string]> = [];
    for (const line of lines) {
      const item = line.replace(/^\s*[-*]\s*/, '').trim();
      if (!item) continue;
      const index = item.search(/[:：]/);
      if (index < 0) continue;
      entries.push([item.slice(0, index), item.slice(index + 1).trim()]);
    }
    return entries;
  };

  const notes: string[] = [];
  for (const [label, value] of readEntries(buffers.exec)) {
    const kind = matchLabel(label);
    if (kind === 'time') form.time = parseTime(value);
    else if (kind === 'git') form.git = parseTri(value);
    else if (kind === 'tests') form.tests = parseTri(value);
    else if (kind === 'plan') form.plan = parsePlan(value);
    else notes.push(`- ${label}：${value}`);
  }
  for (const [label, value] of readEntries(buffers.context)) {
    const kind = matchLabel(label);
    if (kind === 'files') form.files = value;
    else if (kind === 'stack') form.stack = value;
    else if (kind === 'constraints') form.constraints = value;
    else if (kind === 'lang') form.lang = parseLang(value);
    else notes.push(`- ${label}：${value}`);
  }

  const looseNotes = [...buffers.context, ...buffers.exec]
    .filter((line) => line.trim() && !/^\s*[-*]\s*\S+[:：]/.test(line))
    .join('\n')
    .trim();
  if (looseNotes) notes.push(looseNotes);
  form.notes = notes.join('\n');

  return form;
}

/** 描述文本 → 表单：结构化内容按段落解析，其余整体作为问题描述。 */
export function promptFormFromText(text: string): PromptFormState {
  return parsePrompt(text) ?? { ...EMPTY_PROMPT_FORM, problem: text };
}

function labelOf(
  options: readonly { value: string; label: string }[],
  value: string,
): string {
  return options.find((item) => item.value === value)?.label ?? '';
}

function Segmented({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div
      aria-label={ariaLabel}
      className="grid gap-1 rounded-lg bg-muted p-1"
      role="group"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={cn(
            'rounded-md px-2 py-1 text-xs transition',
            value === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
            disabled && 'cursor-not-allowed opacity-60',
          )}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(value === option.value ? '' : option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ChoiceSelect({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  placeholder,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  placeholder: string;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        const id = typeof next === 'string' ? next : '';
        onChange(id === NONE ? '' : id);
      }}
      value={value || NONE}
    >
      <SelectTrigger aria-label={ariaLabel} className="w-full">
        <SelectValue>
          {(current) => {
            const id = typeof current === 'string' ? current : '';
            return id === NONE || !id ? (
              <span className="truncate text-muted-foreground">{placeholder}</span>
            ) : (
              <span className="truncate">{labelOf(options, id)}</span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** 提示词增强表单：任何改动都立即序列化回写任务描述。 */
export function PromptEnhancerForm({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [form, setForm] = useState<PromptFormState>(() => promptFormFromText(value));
  const [advancedOpen, setAdvancedOpen] = useState(() => hasAdvancedFields(promptFormFromText(value)));
  const [presets, setPresets] = useState<PromptPreset[]>(loadPromptPresets);
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const lastEmitted = useRef<string | null>(null);

  useEffect(() => {
    if (value === lastEmitted.current) return;
    const next = promptFormFromText(value);
    lastEmitted.current = null;
    setForm(next);
    if (hasAdvancedFields(next)) setAdvancedOpen(true);
  }, [value]);

  const replace = (next: PromptFormState) => {
    const text = serializePrompt(next);
    lastEmitted.current = text;
    setForm(next);
    onChange(text);
  };

  const update = (patch: Partial<PromptFormState>) => {
    replace(normalizePromptForm({ ...form, ...patch }));
  };

  const selectedPreset = presets.find((preset) => preset.id === presetId) ?? null;

  const savePreset = () => {
    const name = presetName.trim();
    if (!name || disabled) return;
    const existing = presets.find((preset) => preset.name === name);
    const saved: PromptPreset = {
      id: existing?.id ?? makePresetId(),
      name,
      form: normalizePromptForm(form),
    };
    const next = existing
      ? presets.map((preset) => (preset.id === existing.id ? saved : preset))
      : [...presets, saved];
    setPresets(next);
    persistPromptPresets(next);
    setPresetId(saved.id);
    setPresetName('');
  };

  const applyPreset = () => {
    if (!selectedPreset || disabled) return;
    replace(normalizePromptForm(selectedPreset.form));
  };

  const deletePreset = () => {
    if (!selectedPreset) return;
    const next = presets.filter((preset) => preset.id !== selectedPreset.id);
    setPresets(next);
    persistPromptPresets(next);
    setPresetId('');
  };

  const advancedCount = ADVANCED_KEYS.filter((key) => form[key].trim()).length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        表单改动会实时写入任务描述，切回「基础表单」可查看原始文本。
      </p>

      <div className="space-y-2 rounded-lg border bg-muted/30 p-2">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">预设</span>
          <div className="min-w-0 flex-1">
            <ChoiceSelect
              ariaLabel="提示词预设"
              disabled={disabled || !presets.length}
              onChange={setPresetId}
              options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
              placeholder={presets.length ? '选择预设…' : '暂无预设'}
              value={presetId}
            />
          </div>
          <Button
            disabled={!selectedPreset || disabled}
            onClick={applyPreset}
            size="xs"
            type="button"
            variant="outline"
          >
            应用
          </Button>
          <Button
            disabled={!selectedPreset || disabled}
            onClick={deletePreset}
            size="xs"
            type="button"
            variant="ghost"
          >
            删除
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Input
            aria-label="预设名称"
            disabled={disabled}
            onChange={(event) => setPresetName(event.target.value)}
            placeholder="预设名称，保存当前表单"
            value={presetName}
          />
          <Button
            disabled={disabled || !presetName.trim()}
            onClick={savePreset}
            size="xs"
            type="button"
            variant="outline"
          >
            保存
          </Button>
        </div>
      </div>

      <Field label="问题描述">
        <Textarea
          aria-label="问题描述"
          disabled={disabled}
          onChange={(event) => update({ problem: event.target.value })}
          placeholder="要解决的问题、背景与目标…"
          rows={4}
          value={form.problem}
        />
      </Field>

      <Field label="验收标准">
        <Textarea
          aria-label="验收标准"
          disabled={disabled}
          onChange={(event) => update({ acceptance: event.target.value })}
          placeholder="可验证的完成标准，例如：构建通过、指定行为正确…"
          rows={2}
          value={form.acceptance}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="预期执行时间">
          <ChoiceSelect
            ariaLabel="预期执行时间"
            disabled={disabled}
            onChange={(next) => update({ time: next })}
            options={TIME_OPTIONS}
            placeholder="不指定"
            value={form.time}
          />
        </Field>
        <Field label="执行方式">
          <Segmented
            ariaLabel="执行方式"
            disabled={disabled}
            onChange={(next) => update({ plan: next })}
            options={PLAN_OPTIONS}
            value={form.plan}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Git 提交">
          <Segmented
            ariaLabel="Git 提交"
            disabled={disabled}
            onChange={(next) => update({ git: next })}
            options={GIT_OPTIONS}
            value={form.git}
          />
        </Field>
        <Field label="自动化测试">
          <Segmented
            ariaLabel="自动化测试"
            disabled={disabled}
            onChange={(next) => update({ tests: next })}
            options={TEST_OPTIONS}
            value={form.tests}
          />
        </Field>
      </div>

      <div className="space-y-3 border-t pt-3">
        <button
          aria-expanded={advancedOpen}
          className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          onClick={() => setAdvancedOpen((open) => !open)}
          type="button"
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-180')}
          />
          高级选项
          {advancedCount > 0 ? (
            <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
              {advancedCount}
            </span>
          ) : null}
        </button>

        {advancedOpen ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="涉及文件 / 模块">
                <Input
                  aria-label="涉及文件 / 模块"
                  disabled={disabled}
                  onChange={(event) => update({ files: event.target.value })}
                  placeholder="src/foo.ts, src/bar/"
                  value={form.files}
                />
              </Field>
              <Field label="技术栈 / 框架">
                <Input
                  aria-label="技术栈 / 框架"
                  disabled={disabled}
                  onChange={(event) => update({ stack: event.target.value })}
                  placeholder="React 19、Node 22…"
                  value={form.stack}
                />
              </Field>
            </div>
            <Field label="约束与禁止事项">
              <Textarea
                aria-label="约束与禁止事项"
                disabled={disabled}
                onChange={(event) => update({ constraints: event.target.value })}
                placeholder="不要改动 X，必须兼容 Y…"
                rows={2}
                value={form.constraints}
              />
            </Field>
            <Field label="输出语言">
              <ChoiceSelect
                ariaLabel="输出语言"
                disabled={disabled}
                onChange={(next) => update({ lang: next })}
                options={LANG_OPTIONS}
                placeholder="不指定"
                value={form.lang}
              />
            </Field>
            <Field label="其他补充">
              <Textarea
                aria-label="其他补充"
                disabled={disabled}
                onChange={(event) => update({ notes: event.target.value })}
                placeholder="参考资料、相关链接、额外说明…"
                rows={2}
                value={form.notes}
              />
            </Field>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">
          描述是唯一数据源，可在两个页签间往返编辑。
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            disabled={disabled}
            onClick={() => {
              lastEmitted.current = null;
              setForm(promptFormFromText(value));
            }}
            size="xs"
            title="按当前任务描述重新解析表单"
            type="button"
            variant="ghost"
          >
            重新读取
          </Button>
          <Button
            disabled={disabled || !hasAnyField(form)}
            onClick={() => replace({ ...EMPTY_PROMPT_FORM })}
            size="xs"
            type="button"
            variant="ghost"
          >
            清空
          </Button>
        </div>
      </div>
    </div>
  );
}
