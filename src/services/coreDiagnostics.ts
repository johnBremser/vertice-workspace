import type { CoreDiagnosticEntry } from './gateway';

const MAX_DIAGNOSTIC_ENTRIES = 120;

function sanitizeDetail(detail: string): string {
  // Never log bearer tokens, passwords, cookie strings, or long payloads.
  return detail
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]')
    .replace(/(password|token|cookie|secret)=([^\s&;]+)/gi, '$1=[redacted]')
    .slice(0, 260);
}

export class CoreDiagnosticsLog {
  private entries: CoreDiagnosticEntry[] = [];

  record(entry: Omit<CoreDiagnosticEntry, 'timestamp'>): void {
    this.entries.push({
      ...entry,
      timestamp: new Date().toISOString(),
      detail: sanitizeDetail(entry.detail),
    });
    if (this.entries.length > MAX_DIAGNOSTIC_ENTRIES) {
      this.entries = this.entries.slice(-MAX_DIAGNOSTIC_ENTRIES);
    }
  }

  list(): CoreDiagnosticEntry[] {
    return [...this.entries].reverse();
  }

  clear(): void {
    this.entries = [];
  }
}
