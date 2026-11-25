import { FolderOpen } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { FolderBrowserModal } from './FolderBrowserModal';

interface WorkspacePathInputProps {
  id: string;
  value: string;
  onChange: (nextValue: string) => void;
  placeholder?: string;
  suggestions?: string[];
  disabled?: boolean;
}

export function WorkspacePathInput({
  id,
  value,
  onChange,
  placeholder = 'Ex.: C:/projetos/meu-app',
  suggestions = [],
  disabled = false,
}: WorkspacePathInputProps) {
  const listId = useId();
  const [browserOpen, setBrowserOpen] = useState(false);

  const uniqueSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of suggestions) {
      const clean = raw.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
    return out;
  }, [suggestions]);

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <input
          id={id}
          type="text"
          list={uniqueSuggestions.length > 0 ? listId : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => setBrowserOpen(true)}
          disabled={disabled}
          aria-label="Selecionar pasta do workspace"
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-subtle)] disabled:opacity-50"
        >
          <FolderOpen className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
          <span>Selecionar pasta</span>
        </button>
      </div>

      {uniqueSuggestions.length > 0 && (
        <datalist id={listId}>
          {uniqueSuggestions.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      )}

      <FolderBrowserModal
        open={browserOpen}
        initialPath={value}
        onClose={() => setBrowserOpen(false)}
        onSelect={onChange}
      />
    </>
  );
}
