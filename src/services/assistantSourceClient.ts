export interface AssistantSourceMeta {
  ok: boolean;
  service: string;
  accessMode: 'read_only';
  rootDir: string;
  allowedDirs: string[];
  allowedRootFiles: string[];
}

export interface AssistantSourceFileEntry {
  path: string;
  sizeBytes: number;
}

export interface AssistantSourceFileSlice {
  ok: boolean;
  path: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  lines: Array<{ lineNumber: number; text: string }>;
  content: string;
}

export interface AssistantSourceSearchMatch {
  path: string;
  lineNumber: number;
  preview: string;
}

async function fetchAssistantJson<T>(url: string): Promise<T | null> {
  if (
    typeof fetch !== 'function' ||
    typeof window === 'undefined' ||
    !window.location?.origin ||
    window.location.origin === 'null'
  ) {
    return null;
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchAssistantSourceMeta(): Promise<AssistantSourceMeta | null> {
  const data = await fetchAssistantJson<AssistantSourceMeta>(
    '/__vertice_assistant/meta',
  );
  return data?.ok ? data : null;
}

export async function listAssistantSourceFiles(): Promise<AssistantSourceFileEntry[]> {
  const data = await fetchAssistantJson<{
    ok: boolean;
    files?: AssistantSourceFileEntry[];
  }>('/__vertice_assistant/files');
  return data?.ok && Array.isArray(data.files) ? data.files : [];
}

export async function readAssistantSourceFile(
  relPath: string,
  startLine = 1,
  endLine = 180,
): Promise<AssistantSourceFileSlice | null> {
  const params = new URLSearchParams({
    path: relPath,
    startLine: String(startLine),
    endLine: String(endLine),
  });
  const data = await fetchAssistantJson<AssistantSourceFileSlice>(
    `/__vertice_assistant/file?${params.toString()}`,
  );
  return data?.ok ? data : null;
}

export async function searchAssistantSourceFiles(
  query: string,
  limit = 8,
): Promise<AssistantSourceSearchMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const params = new URLSearchParams({
    q: trimmed,
    limit: String(limit),
  });
  const data = await fetchAssistantJson<{
    ok: boolean;
    matches?: AssistantSourceSearchMatch[];
  }>(`/__vertice_assistant/search?${params.toString()}`);
  return data?.ok && Array.isArray(data.matches) ? data.matches : [];
}
