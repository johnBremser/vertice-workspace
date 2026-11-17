import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: EmptyStateProps) {
  return (
    <div className="mx-auto my-8 flex max-w-md flex-col items-center rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-6 py-8 text-center">
      {icon && (
        <div className="mb-3 text-[var(--text-secondary)]" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
        {title}
      </h3>
      <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
