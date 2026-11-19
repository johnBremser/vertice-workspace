import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  makeDemoModelRef,
  makePreferenceModelRef,
} from '../../domain/presets';
import {
  getParticipantRoles,
  selectableConnectionsForMode,
  sortParticipantsByTabOrder,
  validateTeamConfiguration,
} from '../../domain/teamValidation';
import type {
  ModelRef,
  Participant,
  ParticipantRole,
} from '../../domain/types';
import { PT_BR } from '../../i18n/ptBR';
import { useWorkspace } from '../workspace/WorkspaceContext';

const ALL_ROLES: ParticipantRole[] = [
  'coordinator',
  'planner',
  'executor',
  'reviewer',
];

function ParticipantEditorRow({
  participant,
  index,
  total,
  connections,
  workspaceMode,
  canRemove,
  transitionReason,
  onMove,
  onSave,
  onRemove,
}: {
  participant: Participant;
  index: number;
  total: number;
  workspaceMode: 'demo' | 'aion_core';
  connections: {
    id: string;
    displayName: string;
    mode: 'demo' | 'aion_core';
    availableModels: {
      externalId: string;
      displayName: string;
      source: 'demo_tier' | 'core_catalog' | 'core_session';
      tier?: 'fast' | 'review' | 'advanced';
      confirmed: boolean;
    }[];
  }[];
  canRemove: boolean;
  transitionReason: string;
  onMove: (dir: -1 | 1) => Promise<void>;
  onSave: (input: {
    participantId: string;
    displayName: string;
    roles: ParticipantRole[];
    connectionId: string;
    modelRef: ModelRef;
    instructions: string;
    reason?: string;
  }) => Promise<void>;
  onRemove: (participantId: string) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(participant.displayName);
  const [connectionId, setConnectionId] = useState(participant.connectionId);
  const [roles, setRoles] = useState<ParticipantRole[]>(
    getParticipantRoles(participant),
  );
  const [selectedModelKey, setSelectedModelKey] = useState<string>(
    participant.modelRef.confirmation === 'unverified_preference'
      ? '__custom__'
      : participant.modelRef.externalId ??
          `demo:${participant.modelTier}`,
  );
  const [customModelName, setCustomModelName] = useState(
    participant.modelRef.confirmation === 'unverified_preference'
      ? participant.modelRef.displayName
      : '',
  );
  const [instructions, setInstructions] = useState(participant.instructions);

  useEffect(() => {
    setDisplayName(participant.displayName);
    setConnectionId(participant.connectionId);
    setRoles(getParticipantRoles(participant));
    setSelectedModelKey(
      participant.modelRef.confirmation === 'unverified_preference'
        ? '__custom__'
        : participant.modelRef.externalId ??
            `demo:${participant.modelTier}`,
    );
    setCustomModelName(
      participant.modelRef.confirmation === 'unverified_preference'
        ? participant.modelRef.displayName
        : '',
    );
    setInstructions(participant.instructions);
  }, [participant]);

  const currentConnection =
    connections.find((c) => c.id === connectionId) ?? connections[0];

  const toggleRole = (role: ParticipantRole) => {
    setRoles((prev) => {
      if (prev.includes(role)) {
        return prev.length > 1 ? prev.filter((r) => r !== role) : prev;
      }
      return [...prev, role];
    });
  };

  const buildModelRef = (): ModelRef => {
    if (selectedModelKey === '__custom__') {
      return makePreferenceModelRef(
        customModelName.trim() || participant.modelRef.displayName,
        participant.modelTier,
      );
    }
    const found = currentConnection?.availableModels.find(
      (m) => m.externalId === selectedModelKey,
    );
    if (found) {
      if (found.source === 'demo_tier' && found.tier) {
        return makeDemoModelRef(found.tier, found.displayName);
      }
      return {
        externalId: found.externalId,
        displayName: found.displayName,
        source: found.source,
        tier: found.tier ?? participant.modelTier,
        confirmation: found.confirmed ? 'confirmed' : 'unverified_preference',
      };
    }
    return participant.modelRef;
  };

  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            {participant.displayName}
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            Estado: {PT_BR.participantStatusLabels[participant.status]} · Sessão{' '}
            <code className="font-mono text-[11px]">
              {participant.sessionRef.id}
            </code>
          </div>
          {(participant.sessionRef.externalTeamId ||
            participant.sessionRef.externalSlotId ||
            participant.sessionRef.externalConversationId ||
            participant.sessionRef.nativeSessionId) && (
            <details className="mt-1 text-[11px] text-[var(--text-muted)]">
              <summary className="cursor-pointer select-none hover:text-[var(--text-secondary)]">
                Vínculos de sessão no Core
              </summary>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                {participant.sessionRef.externalTeamId && (
                  <span>team={participant.sessionRef.externalTeamId}</span>
                )}
                {participant.sessionRef.externalSlotId && (
                  <span>slot={participant.sessionRef.externalSlotId}</span>
                )}
                {participant.sessionRef.externalConversationId && (
                  <span>extConv={participant.sessionRef.externalConversationId}</span>
                )}
                {participant.sessionRef.nativeSessionId && (
                  <span>cliSession={participant.sessionRef.nativeSessionId}</span>
                )}
              </div>
            </details>
          )}
          {!(
            participant.sessionRef.externalTeamId ||
            participant.sessionRef.externalSlotId ||
            participant.sessionRef.externalConversationId ||
            participant.sessionRef.nativeSessionId
          ) &&
            participant.sessionRef.importedExternalRef && (
              <details className="mt-1 text-[11px] text-[var(--status-warning)]">
                <summary className="cursor-pointer select-none">
                  Referência histórica importada (desvinculada — requer nova vinculação)
                </summary>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                  {participant.sessionRef.importedExternalRef.externalTeamId && (
                    <span>
                      origTeam=
                      {participant.sessionRef.importedExternalRef.externalTeamId}
                    </span>
                  )}
                  {participant.sessionRef.importedExternalRef.externalSlotId && (
                    <span>
                      origSlot=
                      {participant.sessionRef.importedExternalRef.externalSlotId}
                    </span>
                  )}
                  {participant.sessionRef.importedExternalRef
                    .externalConversationId && (
                    <span>
                      origConv=
                      {
                        participant.sessionRef.importedExternalRef
                          .externalConversationId
                      }
                    </span>
                  )}
                  {participant.sessionRef.importedExternalRef
                    .nativeSessionId && (
                    <span>
                      origCliSession=
                      {
                        participant.sessionRef.importedExternalRef
                          .nativeSessionId
                      }
                    </span>
                  )}
                </div>
              </details>
            )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={index === 0}
            aria-label={`Mover aba de ${participant.displayName} para esquerda`}
            onClick={() => void onMove(-1)}
            className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={index >= total - 1}
            aria-label={`Mover aba de ${participant.displayName} para direita`}
            onClick={() => void onMove(1)}
            className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={!canRemove}
            title={
              canRemove
                ? 'Arquivar participante desta conversa'
                : 'Transfira a coordenação antes de arquivar este participante.'
            }
            aria-label={`Arquivar ${participant.displayName}`}
            onClick={() => void onRemove(participant.id)}
            className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-1 text-[var(--text-secondary)] hover:text-[var(--status-danger)] disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs text-[var(--text-secondary)]">
          Nome exibido na aba
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
          />
        </label>

        <label className="block text-xs text-[var(--text-secondary)]">
          Conexão / adaptador
          <select
            value={connectionId}
            onChange={(e) => {
              const nextId = e.target.value;
              setConnectionId(nextId);
              const nextConn = connections.find((c) => c.id === nextId);
              if (
                nextConn?.availableModels.length &&
                !nextConn.availableModels.some(
                  (m) => m.externalId === selectedModelKey,
                )
              ) {
                setSelectedModelKey(nextConn.availableModels[0].externalId);
              }
            }}
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
          >
            {(!connectionId || !currentConnection) && (
              <option value="">
                Provedor indisponível — selecione uma conexão
              </option>
            )}
            {selectableConnectionsForMode(
              connections,
              connectionId,
              currentConnection?.mode ?? 'aion_core',
              workspaceMode,
            ).map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.displayName}
              </option>
            ))}
          </select>
          {(!connectionId || !currentConnection) && (
            <span className="mt-1 block text-[11px] text-[var(--status-warning)]">
              O provedor esperado por este perfil não está disponível no catálogo do AionCore. Escolha explicitamente uma conexão acima antes de criar o time.
            </span>
          )}
        </label>
      </div>

      <div>
        <span className="block text-xs text-[var(--text-secondary)]">
          Papéis nesta conversa (combináveis)
        </span>
        <div className="mt-1.5 flex flex-wrap gap-3">
          {ALL_ROLES.map((role) => (
            <label
              key={role}
              className="inline-flex items-center gap-1.5 text-xs text-[var(--text-primary)]"
            >
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={() => toggleRole(role)}
              />
              <span>{PT_BR.roleLabels[role]}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs text-[var(--text-secondary)]">
          Modelo / perfil de execução
          <select
            value={selectedModelKey}
            onChange={(e) => setSelectedModelKey(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
          >
            {(currentConnection?.availableModels ?? []).map((m) => (
              <option key={m.externalId} value={m.externalId}>
                {m.displayName}
              </option>
            ))}
            <option value="__custom__">
              Preferência declarada (não verificada no Core)
            </option>
          </select>
        </label>

        {selectedModelKey === '__custom__' && (
          <label className="block text-xs text-[var(--text-secondary)]">
            Nome da preferência (ex.: Terra 6.1, Sol 6.1, Gemini Hydrogen)
            <input
              type="text"
              value={customModelName}
              onChange={(e) => setCustomModelName(e.target.value)}
              placeholder="Ex.: Terra 6.1 (preferência)"
              className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
            />
          </label>
        )}
      </div>

      <div>
        <label className="block text-xs text-[var(--text-secondary)]">
          Instruções fixas do participante
          <textarea
            rows={2}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-[var(--text-muted)]">
          Alterações de modelo/instruções aplicam-se apenas à próxima tentativa (nunca reescrevem tentativas passadas).
        </span>
        <button
          type="button"
          onClick={() =>
            void onSave({
              participantId: participant.id,
              displayName: displayName.trim() || participant.displayName,
              roles,
              connectionId,
              modelRef: buildModelRef(),
              instructions,
              reason: transitionReason,
            })
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
        >
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Aplicar alterações</span>
        </button>
      </div>
    </div>
  );
}

export function ParticipantsSection() {
  const {
    store,
    activeConversation,
    applyTeamPreset,
    saveTeamPreset,
    saveParticipantProfile,
    archiveParticipantProfile,
    addParticipantToConversation,
    removeParticipantFromConversation,
    reorderParticipantTabs,
    configureParticipant,
  } = useWorkspace();

  const [transitionReason, setTransitionReason] = useState(
    'Reorganização manual de papéis e equipe na conversa.',
  );
  const [selectedPresetId, setSelectedPresetId] = useState(
    'preset_terra_sol_gemini',
  );
  const [presetNameToSave, setPresetNameToSave] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProfileId, setNewProfileId] = useState('');
  const [newName, setNewName] = useState('');
  const defaultAddConnId =
    store?.executionMode === 'aion_core'
      ? store.connections.find((c) => c.mode === 'aion_core')?.id ??
        store.connections[0]?.id ??
        'conn_codex_demo'
      : 'conn_codex_demo';
  const [newConnId, setNewConnId] = useState(defaultAddConnId);
  const [newRoles, setNewRoles] = useState<ParticipantRole[]>(['executor']);
  const [newModelPref, setNewModelPref] = useState('');
  const [newInstructions, setNewInstructions] = useState(
    'Executar tarefas delegadas respeitando contexto compartilhado.',
  );
  const [showProfilesManager, setShowProfilesManager] = useState(false);

  if (!store || !activeConversation) return null;

  const { participants, coordinatorHistory, configChanges } =
    activeConversation;
  const activeParticipants = sortParticipantsByTabOrder(participants);
  const validation = validateTeamConfiguration(participants, store.connections);

  const handleMove = async (index: number, delta: -1 | 1) => {
    const nextIdx = index + delta;
    if (nextIdx < 0 || nextIdx >= activeParticipants.length) return;
    const ids = activeParticipants.map((p) => p.id);
    const [item] = ids.splice(index, 1);
    ids.splice(nextIdx, 0, item);
    await reorderParticipantTabs(ids);
  };

  const handleAddParticipant = async (e: FormEvent) => {
    e.preventDefault();
    const profile = store.participantProfiles.find(
      (p) => p.id === newProfileId,
    );
    if (profile) {
      await addParticipantToConversation({
        profileId: profile.id,
        connectionId: profile.connectionId,
        displayName: profile.displayName,
        roles: [...profile.defaultRoles],
        modelRef: { ...profile.modelRef },
        instructions: profile.instructions,
      });
    } else {
      if (!newName.trim()) return;
      const targetConnId = newConnId || store.connections[0].id;
      const targetConn = store.connections.find((c) => c.id === targetConnId);
      const trimmedPref = newModelPref.trim();
      const matchedModel = targetConn?.availableModels.find(
        (m) => m.externalId === trimmedPref || m.displayName === trimmedPref,
      ) ?? (!trimmedPref ? targetConn?.availableModels[0] : undefined);
      const modelRef: ModelRef = matchedModel
        ? matchedModel.source === 'demo_tier' && matchedModel.tier
          ? makeDemoModelRef(matchedModel.tier, matchedModel.displayName)
          : {
              externalId: matchedModel.externalId,
              displayName: matchedModel.displayName,
              source: matchedModel.source,
              tier: matchedModel.tier ?? 'fast',
              confirmation: matchedModel.confirmed ? 'confirmed' : 'unverified_preference',
            }
        : trimmedPref
          ? makePreferenceModelRef(trimmedPref, 'fast')
          : makeDemoModelRef('fast');

      await addParticipantToConversation({
        connectionId: targetConnId,
        displayName: newName.trim(),
        roles: newRoles.length > 0 ? newRoles : ['executor'],
        modelRef,
        instructions: newInstructions.trim(),
      });
    }
    setNewName('');
    setNewModelPref('');
    setNewProfileId('');
    setShowAddForm(false);
  };

  const handleSaveCurrentAsPreset = async (e: FormEvent) => {
    e.preventDefault();
    if (!presetNameToSave.trim()) return;
    await saveTeamPreset({
      name: presetNameToSave.trim(),
      description: `Preset salvo a partir da conversa "${activeConversation.conversation.title}".`,
      mode: activeConversation.conversation.executionMode,
      members: activeParticipants.map((p) => ({
        profileId: p.profileId,
        connectionId: p.connectionId,
        displayName: p.displayName,
        roles: getParticipantRoles(p),
        modelRef: { ...p.modelRef },
        instructions: p.instructions,
      })),
    });
    setPresetNameToSave('');
  };

  return (
    <section
      aria-labelledby="settings-participants-title"
      className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5"
    >
      <div className="border-b border-[var(--border-hairline)] pb-3">
        <h2
          id="settings-participants-title"
          className="text-sm font-semibold text-[var(--text-primary)]"
        >
          Equipe configurável, papéis e presets da conversa ativa
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
          Monte times com múltiplas instâncias da mesma conexão (ex.: Terra 6.1 e Sol 6.1 em sessões Codex distintas) e combine papéis sem depender de um fornecedor fixo.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3">
        <label className="min-w-[240px] flex-1 text-xs text-[var(--text-secondary)]">
          Aplicar preset de equipe nesta conversa
          <select
            value={selectedPresetId}
            onChange={(e) => setSelectedPresetId(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
          >
            {store.teamPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void applyTeamPreset(selectedPresetId)}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
        >
          Aplicar preset na conversa
        </button>
      </div>

      {(validation.errors.length > 0 || validation.warnings.length > 0) && (
        <div
          role="status"
          className="mt-3 space-y-1.5 rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] p-3 text-xs"
        >
          {validation.errors.map((err, i) => (
            <div
              key={`err-${i}`}
              className="flex items-start gap-1.5 font-medium text-[var(--status-danger)]"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{err}</span>
            </div>
          ))}
          {validation.warnings.map((warn, i) => (
            <div
              key={`warn-${i}`}
              className="flex items-start gap-1.5 text-[var(--status-warning)]"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{warn}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4">
        <label
          htmlFor="coord-transition-reason"
          className="block text-xs font-medium text-[var(--text-secondary)]"
        >
          Justificativa para troca de coordenador ou reconfiguração
        </label>
        <input
          id="coord-transition-reason"
          type="text"
          value={transitionReason}
          onChange={(e) => setTransitionReason(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--text-primary)]"
        />
      </div>

      <div className="mt-4 divide-y divide-[var(--border-hairline)]">
        {activeParticipants.map((p, index) => {
          const isCurrentCoord =
            p.id === activeConversation.conversation.coordinatorParticipantId;
          return (
            <ParticipantEditorRow
              key={p.id}
              participant={p}
              index={index}
              total={activeParticipants.length}
              connections={store.connections}
              workspaceMode={activeConversation.conversation.executionMode}
              canRemove={!isCurrentCoord}
              transitionReason={transitionReason}
              onMove={(dir) => handleMove(index, dir)}
              onSave={(input) => configureParticipant(input)}
              onRemove={(id) =>
                removeParticipantFromConversation(
                  id,
                  'Participante arquivado manualmente.',
                )
              }
            />
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-4">
        <button
          type="button"
          onClick={() => setShowAddForm((s) => !s)}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Adicionar participante</span>
        </button>

        <button
          type="button"
          onClick={() => setShowProfilesManager((s) => !s)}
          className="text-xs font-medium text-[var(--accent)] hover:underline"
        >
          {showProfilesManager
            ? 'Ocultar perfis salvos e criação de preset'
            : 'Gerenciar perfis salvos / Salvar preset'}
        </button>
      </div>

      {showAddForm && (
        <form
          onSubmit={(e) => void handleAddParticipant(e)}
          className="mt-3 space-y-3 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3 text-xs"
        >
          <label className="block text-[var(--text-secondary)]">
            A partir de perfil salvo (opcional)
            <select
              value={newProfileId}
              onChange={(e) => setNewProfileId(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
            >
              <option value="">Configurar participante personalizado</option>
              {store.participantProfiles
                .filter(
                  (prof) =>
                    !prof.archived &&
                    (activeConversation.conversation.executionMode !==
                      'aion_core' ||
                      store.connections.some(
                        (c) =>
                          c.id === prof.connectionId && c.mode === 'aion_core',
                      )),
                )
                .map((prof) => (
                  <option key={prof.id} value={prof.id}>
                    {prof.displayName} ({prof.defaultRoles.map((r) => PT_BR.roleLabels[r]).join(' + ')})
                  </option>
                ))}
            </select>
          </label>

          {!newProfileId && (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block text-[var(--text-secondary)]">
                  Nome do participante
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Ex.: Sol Auditor"
                    className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
                  />
                </label>
                <label className="block text-[var(--text-secondary)]">
                  Conexão
                  <select
                    value={newConnId}
                    onChange={(e) => setNewConnId(e.target.value)}
                    className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
                  >
                    {store.connections
                      .filter((c) => c.mode === 'aion_core')
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName}
                        </option>
                      ))}
                  </select>
                  {!store.connections.some((c) => c.mode === 'aion_core') && (
                      <span className="mt-1 block text-[11px] text-[var(--status-warning)]">
                        Nenhuma conexão real do Core disponível ainda: autentique a
                        sessão no painel "Conexão AionCore Local" acima e clique em
                        "Sincronizar catálogo" para trazer os assistentes do Core.
                      </span>
                    )}
                </label>
              </div>
              <div className="flex flex-wrap gap-3">
                {ALL_ROLES.map((role) => (
                  <label key={role} className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={newRoles.includes(role)}
                      onChange={() =>
                        setNewRoles((prev) =>
                          prev.includes(role)
                            ? prev.length > 1
                              ? prev.filter((r) => r !== role)
                              : prev
                            : [...prev, role],
                        )
                      }
                    />
                    <span>{PT_BR.roleLabels[role]}</span>
                  </label>
                ))}
              </div>
              <input
                type="text"
                value={newModelPref}
                onChange={(e) => setNewModelPref(e.target.value)}
                placeholder="Preferência de modelo (opcional, ex.: Sol 6.1)"
                className="w-full rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              />
              <textarea
                rows={2}
                value={newInstructions}
                onChange={(e) => setNewInstructions(e.target.value)}
                className="w-full rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              />
            </>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="rounded border border-[var(--border-hairline)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-contrast)]"
            >
              Adicionar à conversa
            </button>
          </div>
        </form>
      )}

      {showProfilesManager && (
        <div className="mt-3 space-y-3 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-xs">
          <form
            onSubmit={(e) => void handleSaveCurrentAsPreset(e)}
            className="flex flex-wrap items-end gap-2"
          >
            <label className="min-w-[220px] flex-1 text-[var(--text-secondary)]">
              Salvar equipe ativa como novo preset
              <input
                type="text"
                value={presetNameToSave}
                onChange={(e) => setPresetNameToSave(e.target.value)}
                placeholder="Ex.: Time Auditoria Separada"
                className="mt-1 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              />
            </label>
            <button
              type="submit"
              disabled={!presetNameToSave.trim()}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-contrast)] disabled:opacity-50"
            >
              Salvar preset
            </button>
          </form>

          <div>
            <div className="font-semibold text-[var(--text-primary)]">
              Perfis reutilizáveis ({store.participantProfiles.length})
            </div>
            <ul className="mt-1.5 space-y-1">
              {store.participantProfiles.map((prof) => (
                <li
                  key={prof.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5"
                >
                  <div>
                    <strong className="text-[var(--text-primary)]">
                      {prof.displayName}
                    </strong>{' '}
                    <span className="text-[var(--text-secondary)]">
                      · {prof.defaultRoles.map((r) => PT_BR.roleLabels[r]).join(' + ')}
                      {prof.archived ? ' (arquivado)' : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void saveParticipantProfile({
                          displayName: `${prof.displayName} (cópia)`,
                          connectionId: prof.connectionId,
                          defaultRoles: [...prof.defaultRoles],
                          modelRef: { ...prof.modelRef },
                          instructions: prof.instructions,
                          isSimulated: prof.isSimulated,
                        })
                      }
                      className="text-[var(--accent)] hover:underline"
                    >
                      Duplicar
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void archiveParticipantProfile(prof.id, !prof.archived)
                      }
                      className="text-[var(--text-secondary)] hover:underline"
                    >
                      {prof.archived ? 'Restaurar' : 'Arquivar'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {(coordinatorHistory.length > 0 || configChanges.length > 0) && (
        <div className="mt-4 space-y-3 border-t border-[var(--border-hairline)] pt-3">
          {coordinatorHistory.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                Registro de transições de coordenação
              </div>
              <ul className="mt-1.5 space-y-1 text-xs text-[var(--text-secondary)]">
                {coordinatorHistory.map((item) => (
                  <li key={item.id}>
                    {new Date(item.decidedAt).toLocaleTimeString('pt-BR')} ·{' '}
                    {item.reason} ({item.sourceEventId})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {configChanges.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                Alterações auditáveis de configuração ({configChanges.length})
              </div>
              <ul className="mt-1.5 space-y-1 text-xs text-[var(--text-secondary)]">
                {configChanges
                  .slice()
                  .reverse()
                  .slice(0, 6)
                  .map((chg) => (
                    <li key={chg.id}>
                      {new Date(chg.decidedAt).toLocaleTimeString('pt-BR')} ·{' '}
                      {chg.changeKind}: {chg.previousSummary} → {chg.nextSummary}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
