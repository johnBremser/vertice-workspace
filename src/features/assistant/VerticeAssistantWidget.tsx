import {
  ArrowUp,
  BookOpen,
  Bot,
  Check,
  Code2,
  Copy,
  Eye,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Maximize2,
  MessageSquare,
  Minimize2,
  Paperclip,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { VerticeAssistantAttachmentInput } from '../../services/gateway';
import {
  KNOWLEDGE_CATEGORIES,
  VERTICE_KNOWLEDGE_BASE,
  type KnowledgeArticle,
  type KnowledgeCategoryId,
} from '../../knowledge/verticeKnowledgeBase';
import { searchKnowledgeArticles } from '../../knowledge/knowledgeSearch';
import {
  fetchAssistantSourceMeta,
  listAssistantSourceFiles,
  readAssistantSourceFile,
  searchAssistantSourceFiles,
  type AssistantSourceFileEntry,
  type AssistantSourceFileSlice,
  type AssistantSourceSearchMatch,
} from '../../services/assistantSourceClient';
import { MarkdownView } from '../workspace/MarkdownView';
import { useWorkspace } from '../workspace/WorkspaceContext';

interface PendingAssistantAttachment extends VerticeAssistantAttachmentInput {
  previewUrl?: string;
}

const MAX_ASSISTANT_ATTACHMENTS = 5;
const MAX_TEXT_ATTACHMENT_CHARS = 40_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const TEXT_ATTACHMENT_EXT_RE =
  /\.(txt|md|markdown|csv|json|log|ts|tsx|js|jsx|mjs|cjs|css|html|xml|yaml|yml|toml|ini|env|sql|ps1|sh|py|rs|go|java|cs)$/i;

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VerticeAssistantWidget() {
  const {
    store,
    assistantState,
    assistantEligibleConnections,
    assistantOpen,
    assistantTab,
    assistantSourcePreviewPath,
    setAssistantOpen,
    setAssistantTab,
    openAssistantSourceFile,
    setMainSurface,
    configureVerticeAssistant,
    updateVerticeAssistantPreferences,
    sendVerticeAssistantMessage,
    respondVerticeAssistantPermission,
    clearVerticeAssistantHistory,
  } = useWorkspace();

  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showSetupSwitcher, setShowSetupSwitcher] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAssistantAttachment[]
  >([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const [selectedConnId, setSelectedConnId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [includeSource, setIncludeSource] = useState(true);

  const [kbQuery, setKbQuery] = useState('');
  const [kbCategory, setKbCategory] = useState<KnowledgeCategoryId | 'all'>('all');
  const [selectedArticleId, setSelectedArticleId] = useState<string>(
    VERTICE_KNOWLEDGE_BASE[0]?.id ?? '',
  );

  const [sourceAvailable, setSourceAvailable] = useState<boolean | null>(null);
  const [sourceFiles, setSourceFiles] = useState<AssistantSourceFileEntry[]>([]);
  const [sourceSearchQuery, setSourceSearchQuery] = useState('');
  const [sourceMatches, setSourceMatches] = useState<AssistantSourceSearchMatch[]>([]);
  const [activeFileSlice, setActiveFileSlice] =
    useState<AssistantSourceFileSlice | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const activePreviewUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const previewUrls = activePreviewUrlsRef.current;
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      for (const url of previewUrls) {
        URL.revokeObjectURL(url);
      }
      previewUrls.clear();
    };
  }, []);

  useEffect(() => {
    if (!assistantOpen) return;
    const onKeyDown = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setAssistantOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [assistantOpen, setAssistantOpen]);

  useEffect(() => {
    if (assistantEligibleConnections.length === 0) return;
    const cfg = assistantState.config;
    const preferredConn =
      (cfg && assistantEligibleConnections.find((c) => c.id === cfg.connectionId)) ??
      assistantEligibleConnections.find((c) => c.id === selectedConnId) ??
      assistantEligibleConnections[0];
    if (!preferredConn) return;

    if (selectedConnId !== preferredConn.id) {
      setSelectedConnId(preferredConn.id);
    }
    const confirmedModels = preferredConn.availableModels.filter((m) => m.confirmed);
    const preferredModel =
      (cfg && confirmedModels.find((m) => m.externalId === cfg.modelExternalId)) ??
      confirmedModels.find((m) => m.externalId === selectedModelId) ??
      confirmedModels[0];
    if (preferredModel && selectedModelId !== preferredModel.externalId) {
      setSelectedModelId(preferredModel.externalId);
    }
    if (cfg) {
      setIncludeDiagnostics(cfg.includeLiveDiagnostics);
      setIncludeSource(cfg.includeSourceContext);
    }
  }, [assistantEligibleConnections, assistantState.config]);

  useEffect(() => {
    if (assistantOpen && assistantTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [assistantOpen, assistantTab, assistantState.messages.length]);

  useEffect(() => {
    if (!assistantOpen || assistantTab !== 'source') return;
    let active = true;
    setSourceLoading(true);
    void (async () => {
      const meta = await fetchAssistantSourceMeta();
      if (!active) return;
      if (!meta) {
        setSourceAvailable(false);
        setSourceLoading(false);
        return;
      }
      setSourceAvailable(true);
      if (sourceFiles.length === 0) {
        const files = await listAssistantSourceFiles();
        if (active) setSourceFiles(files);
      }
      const targetPath =
        assistantSourcePreviewPath ?? activeFileSlice?.path ?? 'src/App.tsx';
      if (targetPath && activeFileSlice?.path !== targetPath) {
        const slice = await readAssistantSourceFile(targetPath, 1, 180);
        if (active && slice) setActiveFileSlice(slice);
      }
      if (active) setSourceLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [assistantOpen, assistantTab, assistantSourcePreviewPath]);

  const kbHits = useMemo(
    () => searchKnowledgeArticles(kbQuery, kbCategory),
    [kbQuery, kbCategory],
  );

  const selectedArticle: KnowledgeArticle | undefined = useMemo(() => {
    const inHits = kbHits.find((h) => h.article.id === selectedArticleId)?.article;
    return inHits ?? kbHits[0]?.article ?? VERTICE_KNOWLEDGE_BASE[0];
  }, [kbHits, selectedArticleId]);

  const selectedConn = assistantEligibleConnections.find(
    (c) => c.id === selectedConnId,
  );
  const availableModels = (selectedConn?.availableModels ?? []).filter(
    (m) => m.confirmed,
  );

  const hasActiveAssistant = Boolean(
    assistantState.config?.connectionId && assistantState.config?.modelExternalId,
  );

  const quickPrompts = useMemo(() => {
    const prompts: string[] = [];
    if (store?.coreRuntimeStatus === 'unreachable') {
      prompts.push('Por que meu AionCore está inacessível e como corrigir?');
    } else if (!store?.coreSessionAuthenticated) {
      prompts.push('Como autenticar a sessão local do AionCore sem erro CSRF?');
    } else {
      prompts.push('Analise os erros recentes de diagnóstico e o estado atual.');
    }
    prompts.push('Explique a arquitetura do Vértice e o protocolo aion-desk/v1.');
    prompts.push('Como funcionam a aba Geral, abas individuais e Contexto Compartilhado?');
    return prompts;
  }, [store?.coreRuntimeStatus, store?.coreSessionAuthenticated]);

  const handleActivateAssistant = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedConn || !selectedModelId) return;
    const model = availableModels.find((m) => m.externalId === selectedModelId);
    await configureVerticeAssistant({
      connectionId: selectedConn.id,
      modelExternalId: selectedModelId,
      modelDisplayName: model?.displayName ?? selectedModelId,
      includeLiveDiagnostics: includeDiagnostics,
      includeSourceContext: includeSource,
    });
    setShowSetupSwitcher(false);
  };

  const handleAddFiles = async (fileList: FileList | File[] | null) => {
    if (!fileList) return;
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    setAttachmentError(null);
    const availableSlots = MAX_ASSISTANT_ATTACHMENTS - pendingAttachments.length;
    if (availableSlots <= 0) {
      setAttachmentError(
        `Limite de ${MAX_ASSISTANT_ATTACHMENTS} anexos por mensagem atingido.`,
      );
      return;
    }

    const nextItems: PendingAssistantAttachment[] = [];
    const errors: string[] = [];

    for (const file of incoming.slice(0, availableSlots)) {
      const id = `ast_att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const isImage = file.type.startsWith('image/');
      const isText =
        file.type.startsWith('text/') ||
        file.type === 'application/json' ||
        file.type === 'application/xml' ||
        TEXT_ATTACHMENT_EXT_RE.test(file.name);

      if (isImage) {
        if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
          errors.push(`Imagem "${file.name}" excede 10 MB.`);
          continue;
        }
        const previewUrl =
          typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : undefined;
        if (previewUrl) {
          activePreviewUrlsRef.current.add(previewUrl);
        }
        nextItems.push({
          id,
          name: file.name || `captura-${Date.now()}.png`,
          kind: 'image',
          mimeType: file.type || 'image/png',
          sizeBytes: file.size,
          file,
          previewUrl,
        });
      } else if (isText) {
        try {
          const rawText = await file.text();
          const truncated = rawText.length > MAX_TEXT_ATTACHMENT_CHARS;
          nextItems.push({
            id,
            name: file.name,
            kind: 'text',
            mimeType: file.type || 'text/plain',
            sizeBytes: file.size,
            textContent: truncated
              ? rawText.slice(0, MAX_TEXT_ATTACHMENT_CHARS)
              : rawText,
            truncated: truncated || undefined,
          });
        } catch {
          errors.push(`Não foi possível ler o arquivo "${file.name}".`);
        }
      } else {
        errors.push(
          `Formato não suportado em "${file.name}". Use imagens ou arquivos de texto (.txt, .md, .csv, .json, código).`,
        );
      }
    }

    if (incoming.length > availableSlots) {
      errors.push(
        `Apenas os primeiros ${availableSlots} anexo(s) foram adicionados (máximo ${MAX_ASSISTANT_ATTACHMENTS}).`,
      );
    }

    if (nextItems.length > 0) {
      setPendingAttachments((prev) => [...prev, ...nextItems]);
    }
    if (errors.length > 0) {
      setAttachmentError(errors[0] ?? null);
    }
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    void handleAddFiles(files);
    e.target.value = '';
  };

  const handleChatPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item && item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) {
          const ext = f.type.split('/')[1]?.split(';')[0] || 'png';
          const named = new File(
            [f],
            f.name && f.name !== 'image.png'
              ? f.name
              : `print-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`,
            { type: f.type || 'image/png' },
          );
          pastedFiles.push(named);
        }
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      void handleAddFiles(pastedFiles);
    }
  };

  const removePendingAttachment = (attId: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((a) => a.id === attId);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
        activePreviewUrlsRef.current.delete(target.previewUrl);
      }
      return prev.filter((a) => a.id !== attId);
    });
  };

  const handleCopyMessage = async (msgId: string, contentMarkdown: string) => {
    if (!contentMarkdown.trim()) return;
    try {
      await navigator.clipboard.writeText(contentMarkdown);
      setCopiedMessageId(msgId);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedMessageId((curr) => (curr === msgId ? null : curr));
      }, 1600);
    } catch {
      // Clipboard unavailable in restricted browser context
    }
  };

  const handleSendChat = async (overrideText?: string) => {
    const text = (overrideText ?? chatInput).trim();
    const attachmentsToSend = overrideText ? [] : pendingAttachments;
    if (
      (!text && attachmentsToSend.length === 0) ||
      sending ||
      assistantState.status === 'streaming'
    ) {
      return;
    }
    setSending(true);
    setAttachmentError(null);
    if (!overrideText) {
      setChatInput('');
      setPendingAttachments([]);
      for (const att of attachmentsToSend) {
        if (att.previewUrl) {
          URL.revokeObjectURL(att.previewUrl);
          activePreviewUrlsRef.current.delete(att.previewUrl);
        }
      }
    }
    try {
      await sendVerticeAssistantMessage({
        prompt: text,
        attachments:
          attachmentsToSend.length > 0
            ? attachmentsToSend.map(({ previewUrl: _unused, ...rest }) => rest)
            : undefined,
      });
    } finally {
      setSending(false);
    }
  };

  const handleChatKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSendChat();
    }
  };

  const handleAskAboutArticle = (article: KnowledgeArticle) => {
    setAssistantTab('chat');
    setChatInput(
      `Com base no artigo "${article.title}" (${article.relatedFiles.slice(0, 3).join(', ')}), me explique em detalhes como isso funciona na prática.`,
    );
  };

  const handleSourceSearch = async (e: FormEvent) => {
    e.preventDefault();
    setSourceLoading(true);
    try {
      const matches = await searchAssistantSourceFiles(sourceSearchQuery, 15);
      setSourceMatches(matches);
    } finally {
      setSourceLoading(false);
    }
  };

  const handleLoadFileSlice = async (relPath: string, startLine = 1) => {
    setSourceLoading(true);
    try {
      const slice = await readAssistantSourceFile(relPath, startLine, startLine + 179);
      if (slice) {
        setActiveFileSlice(slice);
      }
    } finally {
      setSourceLoading(false);
    }
  };

  return (
    <>
      {!assistantOpen && (
        <button
          type="button"
          onClick={() => setAssistantOpen(true)}
          aria-label="Abrir Assistente e Base de Conhecimento do Vértice"
          className="fixed right-4 bottom-24 z-40 inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--accent)] px-3.5 py-2.5 text-xs font-semibold text-[var(--accent-contrast)] shadow-lg transition-transform hover:scale-[1.02] hover:bg-[var(--accent-hover)] sm:right-5 sm:bottom-5"
        >
          <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Assistente &amp; Guia</span>
        </button>
      )}

      {assistantOpen && (
        <aside
          aria-label="Assistente Flutuante e Base de Conhecimento do Vértice"
          className={`fixed right-3 bottom-3 z-50 flex flex-col overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl transition-[width,height] duration-150 sm:right-5 sm:bottom-5 ${
            expanded
              ? 'h-[min(calc(100vh-8.25rem),820px)] w-[calc(100vw-1.5rem)] sm:w-[min(calc(100vw-2.5rem),760px)] lg:w-[min(calc(100vw-276px),1120px)]'
              : 'h-[min(82vh,640px)] w-[calc(100vw-1.5rem)] sm:w-[450px]'
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                <Bot className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-[var(--text-primary)]">
                    Assistente Vértice
                  </span>
                  <span className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
                    <Eye className="h-2.5 w-2.5" aria-hidden="true" />
                    Somente leitura
                  </span>
                </div>
                <div className="truncate text-[10px] text-[var(--text-muted)]">
                  {hasActiveAssistant
                    ? `Modelo: ${assistantState.config?.modelDisplayName}`
                    : 'Base de Conhecimento offline + IA sob demanda'}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                title={expanded ? 'Restaurar tamanho do Assistente' : 'Expandir janela do Assistente'}
                aria-label={expanded ? 'Restaurar tamanho do Assistente' : 'Expandir janela do Assistente'}
                aria-pressed={expanded}
                onClick={() => setExpanded((prev) => !prev)}
                className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
              >
                {expanded ? (
                  <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
              {assistantTab === 'chat' && assistantEligibleConnections.length > 0 && (
                <button
                  type="button"
                  title="Trocar provedor ou modelo do Assistente"
                  aria-label="Configurar Assistente"
                  onClick={() => setShowSetupSwitcher((s) => !s)}
                  className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                >
                  <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
              {assistantTab === 'chat' && assistantState.messages.length > 0 && (
                <button
                  type="button"
                  title="Limpar conversa do Assistente"
                  aria-label="Limpar conversa do Assistente"
                  onClick={() => void clearVerticeAssistantHistory()}
                  className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--status-danger)]"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                aria-label="Fechar Assistente"
                onClick={() => setAssistantOpen(false)}
                className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Sub-navigation Tabs */}
          <div
            role="tablist"
            aria-label="Seções do Assistente"
            className="grid grid-cols-3 border-b border-[var(--border-hairline)] bg-[var(--bg-canvas)] text-xs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={assistantTab === 'chat'}
              onClick={() => setAssistantTab('chat')}
              className={`flex items-center justify-center gap-1.5 py-2 font-medium transition-colors ${
                assistantTab === 'chat'
                  ? 'border-b-2 border-[var(--accent)] bg-[var(--bg-surface)] text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Chat IA</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={assistantTab === 'kb'}
              onClick={() => setAssistantTab('kb')}
              className={`flex items-center justify-center gap-1.5 py-2 font-medium transition-colors ${
                assistantTab === 'kb'
                  ? 'border-b-2 border-[var(--accent)] bg-[var(--bg-surface)] text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Guia / KB</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={assistantTab === 'source'}
              onClick={() => setAssistantTab('source')}
              className={`flex items-center justify-center gap-1.5 py-2 font-medium transition-colors ${
                assistantTab === 'source'
                  ? 'border-b-2 border-[var(--accent)] bg-[var(--bg-surface)] text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Código-Fonte</span>
            </button>
          </div>

          {/* Tab 1: Chat IA */}
          {assistantTab === 'chat' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {assistantEligibleConnections.length === 0 ? (
                <div className="flex flex-1 flex-col justify-center gap-4 p-5 text-xs">
                  <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-4 space-y-2">
                    <div className="font-semibold text-[var(--text-primary)]">
                      Conecte o primeiro provedor para ativar o Chat IA
                    </div>
                    <p className="leading-relaxed text-[var(--text-secondary)]">
                      O Assistente com IA é liberado assim que o <strong>AionCore local</strong> estiver alcançável, autenticado e com pelo menos <strong>1 provedor/modelo sincronizado</strong> no catálogo.
                    </p>
                    <p className="text-[11px] text-[var(--text-muted)]">
                      Enquanto isso, você já pode usar normalmente as abas <strong>Guia / KB</strong> e <strong>Código-Fonte</strong> offline, sem gastar tokens.
                    </p>
                    <div className="flex flex-wrap gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          setMainSurface('settings');
                          setAssistantOpen(false);
                        }}
                        className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                      >
                        Abrir Configurações Core
                      </button>
                      <button
                        type="button"
                        onClick={() => setAssistantTab('kb')}
                        className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
                      >
                        Explorar Base de Conhecimento
                      </button>
                    </div>
                  </div>
                </div>
              ) : !hasActiveAssistant || showSetupSwitcher ? (
                <form
                  onSubmit={(e) => void handleActivateAssistant(e)}
                  className="flex-1 space-y-3 overflow-y-auto p-4 text-xs"
                >
                  <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3">
                    <div className="font-semibold text-[var(--text-primary)]">
                      {hasActiveAssistant
                        ? 'Trocar conexão e modelo do Assistente'
                        : 'Selecione o 1º provedor como Assistente do Vértice'}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                      Este assistente roda em sessão isolada das suas conversas de projeto, com acesso à Base de Conhecimento, diagnóstico ao vivo e leitura segura do fonte.
                    </p>
                  </div>

                  <label className="block text-[var(--text-secondary)]">
                    Conexão / Provedor sincronizado
                    <select
                      value={selectedConnId}
                      onChange={(e) => {
                        const nextId = e.target.value;
                        setSelectedConnId(nextId);
                        const nextConn = assistantEligibleConnections.find(
                          (c) => c.id === nextId,
                        );
                        const firstConfirmed = nextConn?.availableModels.find(
                          (m) => m.confirmed,
                        );
                        setSelectedModelId(firstConfirmed?.externalId ?? '');
                      }}
                      className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-2 text-xs text-[var(--text-primary)]"
                    >
                      {assistantEligibleConnections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block text-[var(--text-secondary)]">
                    Modelo confirmado
                    <select
                      value={selectedModelId}
                      onChange={(e) => setSelectedModelId(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-2 text-xs text-[var(--text-primary)]"
                    >
                      {availableModels.map((m) => (
                        <option key={m.externalId} value={m.externalId}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="space-y-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-3">
                    <label className="flex cursor-pointer items-start gap-2 text-[var(--text-primary)]">
                      <input
                        type="checkbox"
                        checked={includeDiagnostics}
                        onChange={(e) => {
                          setIncludeDiagnostics(e.target.checked);
                          if (hasActiveAssistant) {
                            updateVerticeAssistantPreferences({
                              includeLiveDiagnostics: e.target.checked,
                            });
                          }
                        }}
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      <span>
                        <strong className="font-medium">Diagnóstico ao vivo</strong>
                        <span className="block text-[11px] text-[var(--text-muted)]">
                          Inclui status /health, catálogo, erros HTTP/WS e etapa atual (sem credenciais).
                        </span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2 text-[var(--text-primary)]">
                      <input
                        type="checkbox"
                        checked={includeSource}
                        onChange={(e) => {
                          setIncludeSource(e.target.checked);
                          if (hasActiveAssistant) {
                            updateVerticeAssistantPreferences({
                              includeSourceContext: e.target.checked,
                            });
                          }
                        }}
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      <span>
                        <strong className="font-medium">Leitura do código-fonte</strong>
                        <span className="block text-[11px] text-[var(--text-muted)]">
                          Anexa trechos relevantes de src/, docs/ e scripts/ em modo somente leitura.
                        </span>
                      </span>
                    </label>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-1">
                    {hasActiveAssistant && (
                      <button
                        type="button"
                        onClick={() => setShowSetupSwitcher(false)}
                        className="rounded-md border border-[var(--border-hairline)] px-3 py-1.5 text-xs text-[var(--text-secondary)]"
                      >
                        Cancelar
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={!selectedConnId || !selectedModelId || assistantState.status === 'configuring'}
                      className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                    >
                      {assistantState.status === 'configuring'
                        ? 'Conectando...'
                        : hasActiveAssistant
                          ? 'Aplicar modelo'
                          : 'Ativar Assistente'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5">
                    {assistantState.messages.length === 0 ? (
                      <div className="space-y-3 text-xs">
                        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3.5 text-[var(--text-secondary)]">
                          <div className="font-semibold text-[var(--text-primary)]">
                            Assistente pronto ({assistantState.config?.modelDisplayName})
                          </div>
                          <p className="mt-1 leading-relaxed">
                            Pergunte sobre funcionamento interno, arquitetura, configurações do AionCore ou peça para analisar problemas atuais da sessão.
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <div className="text-[11px] font-medium text-[var(--text-muted)]">
                            Sugestões rápidas:
                          </div>
                          {quickPrompts.map((qp) => (
                            <button
                              key={qp}
                              type="button"
                              onClick={() => void handleSendChat(qp)}
                              className="block w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                            >
                              {qp}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <>
                        {assistantState.messages
                          .filter(
                            (msg) =>
                              !(
                                msg.role === 'assistant' &&
                                msg.status === 'streaming' &&
                                !msg.contentMarkdown.trim() &&
                                !msg.permissionRequest
                              ),
                          )
                          .map((msg) => (
                            <div
                              key={msg.id}
                              className={`rounded-xl px-3 py-2.5 text-xs ${
                                msg.role === 'user'
                                  ? 'ml-6 bg-[var(--accent-soft)] text-[var(--text-primary)]'
                                  : msg.role === 'system'
                                    ? 'border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] text-[var(--text-primary)]'
                                    : 'mr-2 border border-[var(--border-hairline)] bg-[var(--bg-canvas)] text-[var(--text-primary)]'
                              }`}
                            >
                              <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                                <span className="font-semibold text-[var(--text-secondary)]">
                                  {msg.role === 'user'
                                    ? 'Você'
                                    : msg.role === 'system'
                                      ? 'Guarda de Segurança'
                                      : `Assistente (${assistantState.config?.modelDisplayName ?? 'IA'})`}
                                </span>
                                {msg.status !== 'streaming' &&
                                  msg.contentMarkdown.trim() && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void handleCopyMessage(msg.id, msg.contentMarkdown)
                                      }
                                      title={
                                        copiedMessageId === msg.id
                                          ? 'Mensagem copiada'
                                          : 'Copiar mensagem'
                                      }
                                      aria-label={
                                        copiedMessageId === msg.id
                                          ? 'Mensagem copiada'
                                          : 'Copiar mensagem para a área de transferência'
                                      }
                                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                                    >
                                      {copiedMessageId === msg.id ? (
                                        <>
                                          <Check
                                            className="h-3 w-3 text-[var(--status-success)]"
                                            aria-hidden="true"
                                          />
                                          <span className="text-[var(--status-success)]">
                                            Copiado
                                          </span>
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="h-3 w-3" aria-hidden="true" />
                                          <span>Copiar</span>
                                        </>
                                      )}
                                    </button>
                                  )}
                              </div>

                              {msg.attachments && msg.attachments.length > 0 && (
                                <div className="mb-2 flex flex-wrap gap-1.5">
                                  {msg.attachments.map((att) => (
                                    <span
                                      key={att.id}
                                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]"
                                    >
                                      {att.kind === 'image' ? (
                                        <ImageIcon className="h-3 w-3 text-[var(--accent)]" aria-hidden="true" />
                                      ) : (
                                        <FileText className="h-3 w-3 text-[var(--accent)]" aria-hidden="true" />
                                      )}
                                      <span className="max-w-[180px] truncate font-medium">
                                        {att.name}
                                      </span>
                                      <span className="text-[var(--text-muted)]">
                                        ({formatAttachmentSize(att.sizeBytes)})
                                      </span>
                                    </span>
                                  ))}
                                </div>
                              )}

                              <MarkdownView content={msg.contentMarkdown} />

                              {msg.permissionRequest && (
                                <div className="mt-2 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] p-2.5 space-y-2">
                                  <div className="flex items-center gap-1.5 font-semibold text-[var(--status-warning)]">
                                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    <span>{msg.permissionRequest.actionTitle}</span>
                                  </div>
                                  <code className="block break-all rounded bg-[var(--bg-canvas)] p-1.5 font-mono text-[10px] text-[var(--text-secondary)]">
                                    {msg.permissionRequest.commandPreview}
                                  </code>
                                  {msg.permissionRequest.status === 'pending' ? (
                                    <div className="flex justify-end gap-2">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void respondVerticeAssistantPermission(
                                            msg.permissionRequest!.requestId,
                                            'denied',
                                          )
                                        }
                                        className="rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)]"
                                      >
                                        Recusar
                                      </button>
                                      {!msg.permissionRequest.isWriteAttempt && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            void respondVerticeAssistantPermission(
                                              msg.permissionRequest!.requestId,
                                              'approved',
                                            )
                                          }
                                          className="inline-flex items-center gap-1 rounded bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-contrast)]"
                                        >
                                          <Check className="h-3 w-3" aria-hidden="true" />
                                          Permitir leitura
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="text-[11px] text-[var(--text-muted)]">
                                      Decisão:{' '}
                                      {msg.permissionRequest.status === 'approved'
                                        ? 'Permitido'
                                        : 'Recusado'}
                                    </div>
                                  )}
                                </div>
                              )}

                              {msg.sourcesCited && msg.sourcesCited.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1 border-t border-[var(--border-hairline)] pt-2">
                                  {msg.sourcesCited.map((src) =>
                                    src.startsWith('kb:') ? (
                                      <button
                                        key={src}
                                        type="button"
                                        onClick={() => {
                                          setSelectedArticleId(src.slice(3));
                                          setAssistantTab('kb');
                                        }}
                                        className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--accent)] hover:underline"
                                      >
                                        {src}
                                      </button>
                                    ) : (
                                      <button
                                        key={src}
                                        type="button"
                                        onClick={() => openAssistantSourceFile(src)}
                                        className="inline-flex items-center gap-1 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)]"
                                      >
                                        <FileCode2 className="h-2.5 w-2.5" aria-hidden="true" />
                                        <span>{src}</span>
                                      </button>
                                    ),
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        {(assistantState.status === 'streaming' ||
                          assistantState.messages.some((m) => m.status === 'streaming')) && (
                          <div className="flex justify-start">
                            <div
                              role="status"
                              aria-live="polite"
                              aria-label="Assistente respondendo"
                              className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-secondary)] shadow-xs"
                            >
                              <Bot
                                className="h-3.5 w-3.5 text-[var(--accent)]"
                                aria-hidden="true"
                              />
                              <span className="font-medium text-[var(--text-primary)]">
                                Respondendo
                              </span>
                              <span
                                className="inline-flex items-center gap-1 pt-0.5"
                                aria-hidden="true"
                              >
                                <span className="vertice-typing-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                                <span className="vertice-typing-dot vertice-typing-dot-2 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                                <span className="vertice-typing-dot vertice-typing-dot-3 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                              </span>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {/* Chat Composer */}
                  <div className="border-t border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-3 space-y-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/*,.txt,.md,.markdown,.csv,.json,.log,.ts,.tsx,.js,.jsx,.css,.html,.xml,.yaml,.yml,.sql,.ps1,.sh"
                      onChange={handleFileInputChange}
                      className="hidden"
                      aria-label="Selecionar arquivos ou imagens para anexar"
                    />

                    {attachmentError && (
                      <div
                        role="alert"
                        className="flex items-center justify-between gap-2 rounded-lg border border-[var(--status-danger)]/40 bg-[var(--status-danger-soft)] px-2.5 py-1.5 text-[11px] text-[var(--status-danger)]"
                      >
                        <span>{attachmentError}</span>
                        <button
                          type="button"
                          onClick={() => setAttachmentError(null)}
                          aria-label="Fechar aviso de anexo"
                          className="shrink-0 hover:opacity-75"
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                    )}

                    {pendingAttachments.length > 0 && (
                      <div
                        aria-label="Anexos pendentes"
                        className="flex flex-wrap gap-1.5"
                      >
                        {pendingAttachments.map((att) => (
                          <div
                            key={att.id}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
                          >
                            {att.kind === 'image' && att.previewUrl ? (
                              <img
                                src={att.previewUrl}
                                alt={att.name}
                                className="h-5 w-5 rounded object-cover"
                              />
                            ) : att.kind === 'image' ? (
                              <ImageIcon className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
                            ) : (
                              <FileText className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
                            )}
                            <span className="max-w-[160px] truncate font-medium">
                              {att.name}
                            </span>
                            <span className="text-[10px] text-[var(--text-muted)]">
                              {formatAttachmentSize(att.sizeBytes)}
                            </span>
                            <button
                              type="button"
                              onClick={() => removePendingAttachment(att.id)}
                              aria-label={`Remover anexo ${att.name}`}
                              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                            >
                              <X className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex items-end gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-2 focus-within:border-[var(--accent)]">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={sending || assistantState.status === 'streaming'}
                        title="Anexar imagem, print ou arquivo de texto (.txt, .md, .csv, .json)"
                        aria-label="Anexar arquivo ou imagem"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)] disabled:opacity-45"
                      >
                        <Paperclip className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <label htmlFor="vertice-assistant-input" className="sr-only">
                        Pergunte ao Assistente do Vértice
                      </label>
                      <textarea
                        id="vertice-assistant-input"
                        rows={1}
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={handleChatKeyDown}
                        onPaste={handleChatPaste}
                        placeholder="Pergunte sobre código, peça sugestão de equipe ou cole um print (Ctrl+V)..."
                        className="max-h-36 min-h-[34px] flex-1 resize-y bg-transparent text-xs leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={
                          (!chatInput.trim() && pendingAttachments.length === 0) ||
                          sending ||
                          assistantState.status === 'streaming'
                        }
                        onClick={() => void handleSendChat()}
                        aria-label="Enviar pergunta ao Assistente"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-45"
                      >
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                      <span>Imagens/prints (PNG, JPG, WebP) e textos (.md, .txt, .csv, .json).</span>
                      <span>Ctrl+V para colar print</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Tab 2: Offline Knowledge Base */}
          {assistantTab === 'kb' && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="space-y-2 border-b border-[var(--border-hairline)] p-3">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 text-[var(--text-muted)]"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={kbQuery}
                    onChange={(e) => setKbQuery(e.target.value)}
                    placeholder="Buscar na Base de Conhecimento (ex.: CSRF, reducer, 502)..."
                    aria-label="Buscar na Base de Conhecimento"
                    className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] py-1.5 pr-3 pl-8 text-xs text-[var(--text-primary)]"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => setKbCategory('all')}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      kbCategory === 'all'
                        ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                        : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
                    }`}
                  >
                    Todos
                  </button>
                  {KNOWLEDGE_CATEGORIES.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setKbCategory(cat.id)}
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        kbCategory === cat.id
                          ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                          : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
                {kbHits.length === 0 ? (
                  <p className="py-6 text-center text-xs text-[var(--text-muted)]">
                    Nenhum artigo encontrado para "{kbQuery}".
                  </p>
                ) : (
                  <>
                    <div className="space-y-1">
                      {kbHits.map(({ article }) => {
                        const isSelected = selectedArticle?.id === article.id;
                        return (
                          <button
                            key={article.id}
                            type="button"
                            onClick={() => setSelectedArticleId(article.id)}
                            className={`block w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                              isSelected
                                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                                : 'border-[var(--border-hairline)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-elevated)]'
                            }`}
                          >
                            <div className="text-xs font-semibold text-[var(--text-primary)]">
                              {article.title}
                            </div>
                            <div className="mt-0.5 line-clamp-2 text-[11px] text-[var(--text-secondary)]">
                              {article.summary}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {selectedArticle && (
                      <article className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-canvas)] p-3.5 space-y-3">
                        <div className="border-b border-[var(--border-hairline)] pb-2">
                          <h3 className="text-xs font-semibold text-[var(--text-primary)]">
                            {selectedArticle.title}
                          </h3>
                          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                            {selectedArticle.summary}
                          </p>
                        </div>

                        <MarkdownView content={selectedArticle.bodyMarkdown} />

                        {selectedArticle.relatedFiles.length > 0 && (
                          <div className="border-t border-[var(--border-hairline)] pt-2">
                            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                              Arquivos relacionados (abrir leitura)
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {selectedArticle.relatedFiles.map((filePath) => (
                                <button
                                  key={filePath}
                                  type="button"
                                  onClick={() => openAssistantSourceFile(filePath)}
                                  className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                                >
                                  <FileCode2 className="h-3 w-3" aria-hidden="true" />
                                  <span>{filePath}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {hasActiveAssistant && (
                          <div className="flex justify-end pt-1">
                            <button
                              type="button"
                              onClick={() => handleAskAboutArticle(selectedArticle)}
                              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                            >
                              Perguntar ao Assistente sobre este tópico
                            </button>
                          </div>
                        )}
                      </article>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Tab 3: Read-only Source Code Viewer */}
          {assistantTab === 'source' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {sourceAvailable === false ? (
                <div className="flex flex-1 flex-col justify-center p-5 text-xs">
                  <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-4 space-y-2">
                    <div className="font-semibold text-[var(--text-primary)]">
                      Leitor de código-fonte indisponível neste servidor estático
                    </div>
                    <p className="leading-relaxed text-[var(--text-secondary)]">
                      Para navegar e ler o código-fonte local em modo somente leitura (<code>/__vertice_assistant/*</code>), execute o Vértice via <code>npm start</code> (<code>scripts/vertice-server.mjs</code>) ou <code>npm run dev</code> e certifique-se de que não há uma instância antiga em execução na porta.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <form
                    onSubmit={(e) => void handleSourceSearch(e)}
                    className="flex gap-1.5 border-b border-[var(--border-hairline)] p-3"
                  >
                    <input
                      type="search"
                      value={sourceSearchQuery}
                      onChange={(e) => setSourceSearchQuery(e.target.value)}
                      placeholder="Buscar símbolo/texto em src/, docs/, scripts/..."
                      aria-label="Buscar no código-fonte"
                      className="min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
                    />
                    <button
                      type="submit"
                      className="rounded-md bg-[var(--accent)] px-2.5 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                    >
                      Buscar
                    </button>
                  </form>

                  <div className="border-b border-[var(--border-hairline)] px-3 py-2">
                    <label className="block text-[10px] font-medium text-[var(--text-muted)]">
                      Selecionar arquivo permitido ({sourceFiles.length})
                      <select
                        value={activeFileSlice?.path ?? ''}
                        onChange={(e) => {
                          if (e.target.value) {
                            void handleLoadFileSlice(e.target.value, 1);
                          }
                        }}
                        className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)]"
                      >
                        {sourceFiles.map((f) => (
                          <option key={f.path} value={f.path}>
                            {f.path}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
                    {sourceMatches.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[10px] font-semibold uppercase text-[var(--text-muted)]">
                          Resultados da busca
                        </div>
                        {sourceMatches.map((m, idx) => (
                          <button
                            key={`${m.path}-${m.lineNumber}-${idx}`}
                            type="button"
                            onClick={() =>
                              void handleLoadFileSlice(
                                m.path,
                                Math.max(1, m.lineNumber - 20),
                              )
                            }
                            className="block w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-left hover:border-[var(--accent)]"
                          >
                            <div className="font-mono text-[10px] font-semibold text-[var(--accent)]">
                              {m.path}:{m.lineNumber}
                            </div>
                            <div className="truncate font-mono text-[10px] text-[var(--text-secondary)]">
                              {m.preview}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    {sourceLoading ? (
                      <div className="py-4 text-center text-xs text-[var(--text-muted)]">
                        Carregando leitura somente leitura...
                      </div>
                    ) : activeFileSlice ? (
                      <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-canvas)]">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-3 py-1.5 text-[10px] text-[var(--text-secondary)]">
                          <span className="font-mono font-semibold">
                            {activeFileSlice.path} (L{activeFileSlice.startLine}–
                            {activeFileSlice.endLine}/{activeFileSlice.totalLines})
                          </span>
                          <div className="flex gap-1.5">
                            {activeFileSlice.startLine > 1 && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleLoadFileSlice(
                                    activeFileSlice.path,
                                    Math.max(1, activeFileSlice.startLine - 180),
                                  )
                                }
                                className="rounded border border-[var(--border-hairline)] px-1.5 py-0.5 hover:text-[var(--accent)]"
                              >
                                Anterior
                              </button>
                            )}
                            {activeFileSlice.endLine < activeFileSlice.totalLines && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleLoadFileSlice(
                                    activeFileSlice.path,
                                    activeFileSlice.endLine + 1,
                                  )
                                }
                                className="rounded border border-[var(--border-hairline)] px-1.5 py-0.5 hover:text-[var(--accent)]"
                              >
                                Próximo
                              </button>
                            )}
                          </div>
                        </div>
                        <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-[var(--text-primary)]">
                          <code>{activeFileSlice.content}</code>
                        </pre>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          )}
        </aside>
      )}
    </>
  );
}
