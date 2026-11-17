import { Check, Copy } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';

const LazyReactMarkdown = lazy(() => import('react-markdown'));

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(children ?? '').replace(/\n$/, '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be unavailable in restricted frames.
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--border-hairline)] bg-[var(--bg-canvas)]">
      <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-3 py-1 text-xs text-[var(--text-secondary)]">
        <span className="font-mono">código</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-[var(--status-success)]" aria-hidden="true" />
              <span>Copiado</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" aria-hidden="true" />
              <span>Copiar</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-[var(--text-primary)]">
        <code>{text}</code>
      </pre>
    </div>
  );
}

interface MarkdownViewProps {
  content: string;
}

export function MarkdownView({ content }: MarkdownViewProps) {
  return (
    <Suspense
      fallback={
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-primary)]">
          {content}
        </div>
      }
    >
      <div className="space-y-2 text-sm leading-relaxed text-[var(--text-primary)]">
        <LazyReactMarkdown
          allowedElements={[
            'p',
            'strong',
            'em',
            'code',
            'pre',
            'ul',
            'ol',
            'li',
            'h1',
            'h2',
            'h3',
            'h4',
            'blockquote',
            'a',
            'br',
            'hr',
          ]}
          unwrapDisallowed
          components={{
            h1: ({ children }) => (
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {children}
              </h3>
            ),
            h2: ({ children }) => (
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {children}
              </h3>
            ),
            h3: ({ children }) => (
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                {children}
              </h4>
            ),
            p: ({ children }) => <p className="leading-relaxed">{children}</p>,
            ul: ({ children }) => (
              <ul className="list-disc space-y-1 pl-5">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal space-y-1 pl-5">{children}</ol>
            ),
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            blockquote: ({ children }) => (
              <blockquote className="rounded-md bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                {children}
              </blockquote>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                rel="noopener noreferrer"
                className="underline decoration-[var(--accent)] underline-offset-2 hover:text-[var(--accent)]"
              >
                {children}
              </a>
            ),
            pre: ({ children }) => <>{children}</>,
            code: ({ className, children }) => {
              const raw = String(children ?? '');
              const isBlock = Boolean(className?.startsWith('language-')) || raw.includes('\n');
              if (isBlock) {
                return <CodeBlock>{raw}</CodeBlock>;
              }
              return (
                <code className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-primary)]">
                  {children}
                </code>
              );
            },
          }}
        >
          {content}
        </LazyReactMarkdown>
      </div>
    </Suspense>
  );
}
