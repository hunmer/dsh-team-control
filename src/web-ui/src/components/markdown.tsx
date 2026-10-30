/**
 * 轻量 markdown 渲染（消息正文用）。
 *
 * react-markdown 默认不渲染裸 HTML，消息里的尖括号/表格都按纯文本或常见语法处理，安全。
 * 样式用手写类而不是 typography 插件，避免为一份小卡片再挂一个插件。
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
  a: ({ children, href }) => (
    <a className="break-all underline underline-offset-2" href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="mb-1.5 list-disc space-y-0.5 pl-4 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-1.5 list-decimal space-y-0.5 pl-4 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="marker:text-muted-foreground">{children}</li>,
  h1: ({ children }) => <h4 className="mt-2 mb-1 font-medium text-sm first:mt-0">{children}</h4>,
  h2: ({ children }) => <h4 className="mt-2 mb-1 font-medium text-sm first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-2 mb-1 font-medium first:mt-0">{children}</h5>,
  h4: ({ children }) => <h5 className="mt-2 mb-1 font-medium first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="mt-2 mb-1 font-medium first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-2 mb-1 font-medium first:mt-0">{children}</h6>,
  code: ({ children, className }) => (
    <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[11px]', className)}>{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mb-1.5 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] last:mb-0">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-1.5 border-l-2 pl-2 text-muted-foreground last:mb-0">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  table: ({ children }) => (
    <div className="mb-1.5 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border px-1.5 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-border px-1.5 py-1 align-top">{children}</td>,
};

export function Markdown({ className, text }: { className?: string; text: string }) {
  return (
    <div className={cn('text-xs break-words', className)}>
      <ReactMarkdown components={COMPONENTS} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
