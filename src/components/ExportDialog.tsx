import { Download, FileCode2, FileText, Upload } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';
import { APP_BRAND } from '../config/brand';
import type {
  ConversationProjection,
  ModelPolicy,
  Project,
  WorkspaceStoreState,
} from '../domain/types';
import {
  applyImportedWorkspaceBackup,
  buildConversationMarkdownExport,
  buildWorkspaceJsonExport,
  parseAndValidateWorkspaceBackup,
  triggerFileDownload,
  type BackupValidationResult,
} from '../services/exportService';
import { Modal } from './Modal';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  state: WorkspaceStoreState;
  activeProject?: Project;
  activeConversation?: ConversationProjection;
  modelPolicy: ModelPolicy;
  onImportState?: (nextState: WorkspaceStoreState) => Promise<void>;
}

export function ExportDialog({
  open,
  onClose,
  state,
  activeProject,
  activeConversation,
  modelPolicy,
  onImportState,
}: ExportDialogProps) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [validation, setValidation] = useState<
    Extract<BackupValidationResult, { valid: true }> | null
  >(null);
  const [importing, setImporting] = useState(false);

  const resetMessages = () => {
    setFeedback(null);
    setImportError(null);
    setValidation(null);
  };

  const handleDownloadMarkdown = () => {
    if (!activeConversation) return;
    const content = buildConversationMarkdownExport(
      activeProject,
      activeConversation,
      modelPolicy,
    );
    const slug = activeConversation.conversation.id.replace(/[^a-z0-9_-]/gi, '_');
    triggerFileDownload(
      `aion-desk-historico-${slug}.md`,
      content,
      'text/markdown;charset=utf-8',
    );
    setImportError(null);
    setFeedback(
      'Histórico legível em Markdown gerado localmente (não restaurável como backup).',
    );
  };

  const handleDownloadJson = (onlyCurrent: boolean) => {
    const content = buildWorkspaceJsonExport(
      state,
      onlyCurrent ? activeConversation?.conversation.id : undefined,
    );
    const filename =
      onlyCurrent && activeConversation
        ? `aion-desk-backup-${activeConversation.conversation.id}.json`
        : 'aion-desk-backup-completo.json';
    triggerFileDownload(filename, content, 'application/json;charset=utf-8');
    setImportError(null);
    setFeedback(
      'Backup JSON versionado gerado localmente sem credenciais, tokens ou cookies.',
    );
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    setFeedback(null);
    setImportError(null);
    setValidation(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = parseAndValidateWorkspaceBackup(text);
      if (!result.valid) {
        setImportError(result.error);
        return;
      }
      setValidation(result);
    } catch {
      setImportError('Falha ao ler o arquivo JSON selecionado.');
    }
  };

  const handleConfirmImport = async (mode: 'copy' | 'replace') => {
    if (!validation || !onImportState) return;
    setImporting(true);
    setImportError(null);
    try {
      const nextState = applyImportedWorkspaceBackup(
        state,
        validation.migratedState,
        mode,
      );
      await onImportState(nextState);
      setValidation(null);
      setFeedback(
        mode === 'copy'
          ? 'Backup importado como cópia com novos identificadores preservando referências.'
          : 'Dados atuais substituídos pelo backup validado.',
      );
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Falha ao aplicar backup.',
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        resetMessages();
        onClose();
      }}
      title="Exportar histórico e backup restaurável"
      description="Separe histórico legível (Markdown) de backup JSON versionado e restaurável. Nenhuma credencial ou token é exportado."
    >
      <div className="space-y-4">
        <div className="space-y-2.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            Exportação local
          </div>
          <button
            type="button"
            disabled={!activeConversation}
            onClick={handleDownloadMarkdown}
            className="flex w-full items-center justify-between rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-3 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)] disabled:opacity-50"
          >
            <div className="flex items-start gap-3">
              <FileText
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
                aria-hidden="true"
              />
              <div>
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Exportação de histórico em Markdown (leitura/auditoria)
                </div>
                <div className="text-xs text-[var(--text-secondary)]">
                  Objetivo, participantes, papéis, modelos, revisões de contexto, Geral e abas detalhadas.
                </div>
              </div>
            </div>
            <Download
              className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
          </button>

          <button
            type="button"
            disabled={!activeConversation}
            onClick={() => handleDownloadJson(true)}
            className="flex w-full items-center justify-between rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-3 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)] disabled:opacity-50"
          >
            <div className="flex items-start gap-3">
              <FileCode2
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
                aria-hidden="true"
              />
              <div>
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Backup JSON restaurável da conversa ativa
                </div>
                <div className="text-xs text-[var(--text-secondary)]">
                  Schema v2 com participantes, instruções, tentativas, eventos e presets associados.
                </div>
              </div>
            </div>
            <Download
              className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
          </button>

          <button
            type="button"
            onClick={() => handleDownloadJson(false)}
            className="flex w-full items-center justify-between rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-4 py-3 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]"
          >
            <div className="flex items-start gap-3">
              <FileCode2
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]"
                aria-hidden="true"
              />
              <div>
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Backup JSON completo do workspace
                </div>
                <div className="text-xs text-[var(--text-secondary)]">
                  Projetos, conversas, perfis de participantes, presets de equipe e políticas.
                </div>
              </div>
            </div>
            <Download
              className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
          </button>

          <p className="rounded-md bg-[var(--bg-elevated)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Antes de alterar origem ou porta (<code>host:porta</code>), exporte um backup JSON completo. O armazenamento local (IndexedDB) é isolado por origem no navegador — não copie arquivos internos do banco manualmente como substituto de migração.
          </p>
        </div>

        {onImportState && (
          <div className="space-y-2.5 border-t border-[var(--border-hairline)] pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              Importar backup JSON restaurável
            </div>
            <label
              htmlFor="backup-file-input"
              className="flex cursor-pointer items-center gap-2.5 rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3.5 py-2.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
            >
              <Upload className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
              <span>
                Selecionar arquivo <code>.json</code> exportado pelo{' '}
                {APP_BRAND.name} (ou Aion Desk compatível)
              </span>
              <input
                id="backup-file-input"
                type="file"
                accept="application/json,.json"
                onChange={(e) => void handleFileChange(e)}
                className="sr-only"
              />
            </label>

            {validation && (
              <div className="space-y-2.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3 text-xs">
                <div className="font-semibold text-[var(--text-primary)]">
                  Backup validado antes da importação
                </div>
                <ul className="space-y-1 text-[var(--text-secondary)]">
                  <li>
                    Schema: v{validation.preview.schemaVersion} (exportação{' '}
                    {validation.preview.exportSchemaVersion})
                  </li>
                  <li>
                    Conteúdo: {validation.preview.projectCount} projeto(s),{' '}
                    {validation.preview.conversationCount} conversa(s),{' '}
                    {validation.preview.presetCount} preset(s) e{' '}
                    {validation.preview.profileCount} perfil(is)
                  </li>
                  <li>
                    Modos presentes:{' '}
                    {validation.preview.executionModes.join(', ') || 'demo'}
                  </li>
                </ul>
                <p className="rounded bg-[var(--bg-canvas)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  Importar não inicia execução nem presume autenticação.
                  {(validation.preview.externalTeamRefsCount > 0 ||
                    validation.preview.externalSessionRefsCount > 0) && (
                    <>
                      {' '}
                      Detectado(s) {validation.preview.externalTeamRefsCount} vínculo(s) de equipe e{' '}
                      {validation.preview.externalSessionRefsCount} referência(s) de sessão Core: os vínculos ativos serão desconectados (mantidos apenas como referência histórica) e exigirão vinculação explícita no ambiente atual.
                    </>
                  )}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    disabled={importing}
                    onClick={() => void handleConfirmImport('copy')}
                    className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                  >
                    Importar como cópia
                  </button>
                  <button
                    type="button"
                    disabled={importing}
                    onClick={() => void handleConfirmImport('replace')}
                    className="rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] disabled:opacity-50"
                  >
                    Substituir dados atuais
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {importError && (
          <p
            role="alert"
            className="rounded-md bg-[var(--status-danger-soft)] px-3 py-2 text-xs text-[var(--status-danger)]"
          >
            {importError}
          </p>
        )}

        {feedback && (
          <p className="rounded-md bg-[var(--status-success-soft)] px-3 py-2 text-xs text-[var(--status-success)]">
            {feedback}
          </p>
        )}
      </div>
    </Modal>
  );
}
