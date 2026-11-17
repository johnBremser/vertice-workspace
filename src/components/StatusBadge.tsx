import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  PauseCircle,
  PlayCircle,
  ShieldAlert,
  WifiOff,
  XCircle,
} from 'lucide-react';

export type SemanticTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

interface StatusBadgeProps {
  label: string;
  tone?: SemanticTone;
  iconKind?:
    | 'idle'
    | 'running'
    | 'paused'
    | 'success'
    | 'warning'
    | 'danger'
    | 'disconnected'
    | 'permission'
    | 'pending';
  className?: string;
}

const TONE_TEXT_CLASS: Record<SemanticTone, string> = {
  neutral: 'text-[var(--text-secondary)]',
  accent: 'text-[var(--accent)]',
  success: 'text-[var(--status-success)]',
  warning: 'text-[var(--status-warning)]',
  danger: 'text-[var(--status-danger)]',
};

export function StatusBadge({
  label,
  tone = 'neutral',
  iconKind = 'idle',
  className = '',
}: StatusBadgeProps) {
  const Icon = (() => {
    switch (iconKind) {
      case 'running':
        return PlayCircle;
      case 'paused':
        return PauseCircle;
      case 'success':
        return CheckCircle2;
      case 'warning':
        return AlertTriangle;
      case 'danger':
        return XCircle;
      case 'disconnected':
        return WifiOff;
      case 'permission':
        return ShieldAlert;
      case 'pending':
        return Clock;
      default:
        return CircleDashed;
    }
  })();

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${TONE_TEXT_CLASS[tone]} ${className}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
