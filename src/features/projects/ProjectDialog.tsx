import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import type { TeamPreset } from '../../domain/types';
import { PT_BR } from '../../i18n/ptBR';

export type ProjectModalMode =
  | { kind: 'create_project' }
  | { kind: 'rename_project'; projectId: string; currentName: string }
  | { kind: 'create_conversation'; projectId: string; projectName: string }
  | { kind: 'rename_conversation'; conversationId: string; currentTitle: string }
  | null;

interface ProjectDialogProps {
  mode: ProjectModalMode;
  teamPresets?: TeamPreset[];
  onClose: () => void;
  onCreateProject: (input: {
    name: string;
    description: string;
    workspacePathInfo: string;
  }) => Promise<void>;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onCreateConversation: (
    projectId: string,
    title: string,
    presetId?: string,
  ) => Promise<void>;
  onRenameConversation: (conversationId: string, title: string) => Promise<void>;
}

export function ProjectDialog({
  mode,
  teamPresets = [],
  onClose,
  onCreateProject,
  onRenameProject,
  onCreateConversation,
  onRenameConversation,
}: ProjectDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspacePathInfo, setWorkspacePathInfo] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!mode) return;
    if (mode.kind === 'rename_project') {
      setName(mode.currentName);
    } else if (mode.kind === 'rename_conversation') {
      setName(mode.currentTitle);
    } else {
      setName('');
      setDescription('');
      setWorkspacePathInfo('');
      const preferred =
        teamPresets.find((p) => p.id === 'preset_terra_sol_gemini')?.id ??
        teamPresets[0]?.id ??
        '';
      setSelectedPresetId(preferred);
    }
  }, [mode, teamPresets]);

  if (!mode) return null;

  const title = (() => {
    switch (mode.kind) {
      case 'create_project':
        return PT_BR.newProject;
      case 'rename_project':
        return 'Renomear projeto';
      case 'create_conversation':
        return `${PT_BR.newConversation} em ${mode.projectName}`;
      case 'rename_conversation':
        return 'Renomear conversa';
    }
  })();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Preencha o campo obrigatório.');
      return;
    }
    if (mode.kind === 'create_project') {
      await onCreateProject({ name: trimmed, description, workspacePathInfo });
    } else if (mode.kind === 'rename_project') {
      await onRenameProject(mode.projectId, trimmed);
    } else if (mode.kind === 'create_conversation') {
      await onCreateConversation(
        mode.projectId,
        trimmed,
        selectedPresetId || undefined,
      );
    } else {
      await onRenameConversation(mode.conversationId, trimmed);
    }
    onClose();
  };

  const selectedPreset = teamPresets.find((p) => p.id === selectedPresetId);

  return (
    <Modal open={Boolean(mode)} onClose={onClose} title={title}>
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
        <div>
          <label
            htmlFor="aion-project-name"
            className="block text-xs font-medium text-[var(--text-primary)]"
          >
            {mode.kind.includes('conversation') ? 'Título da conversa' : 'Nome do projeto'}
          </label>
          <input
            id="aion-project-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              mode.kind.includes('conversation')
                ? 'Ex.: Refatorar paginação'
                : 'Ex.: Módulo de relatórios'
            }
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>

        {mode.kind === 'create_conversation' && teamPresets.length > 0 && (
          <div>
            <label
              htmlFor="aion-conv-preset"
              className="block text-xs font-medium text-[var(--text-primary)]"
            >
              Preset inicial de equipe
            </label>
            <select
              id="aion-conv-preset"
              value={selectedPresetId}
              onChange={(e) => setSelectedPresetId(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              {teamPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            {selectedPreset && (
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
                {selectedPreset.description}
              </p>
            )}
          </div>
        )}

        {mode.kind === 'create_project' && (
          <>
            <div>
              <label
                htmlFor="aion-project-desc"
                className="block text-xs font-medium text-[var(--text-primary)]"
              >
                Descrição curta (opcional)
              </label>
              <input
                id="aion-project-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="aion-project-path"
                className="block text-xs font-medium text-[var(--text-primary)]"
              >
                Caminho do workspace (informativo)
              </label>
              <input
                id="aion-project-path"
                type="text"
                value={workspacePathInfo}
                onChange={(e) => setWorkspacePathInfo(e.target.value)}
                placeholder="Ex.: C:/projetos/meu-app"
                className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {PT_BR.previewWorkspaceDisclaimer}
              </p>
            </div>
          </>
        )}

        {error && (
          <p className="text-xs text-[var(--status-danger)]">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--border-strong)]"
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-xs font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
          >
            Salvar
          </button>
        </div>
      </form>
    </Modal>
  );
}
