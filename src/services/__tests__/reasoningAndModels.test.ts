import { describe, expect, it } from 'vitest';
import {
  extractAvailableModelOptions,
  extractReasoningConfigFromConfigOptions,
  formatBracketedModelDisplayName,
} from '../aionCoreDtos';
import { AionCoreAdapter } from '../aionCoreAdapter';
import { MemoryOnlyStorageDriver, WorkspacePersistenceManager } from '../storage';
import {
  REAL_CORE_AUTH_STATUS_V022,
  REAL_CORE_HEALTH_V022,
} from './fixtures/coreV022RealPayloads';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CLI Reasoning & Cursor/Codex Model Metadata', () => {
  it('formats Cursor bracketed capability/reasoning tags cleanly in displayName', () => {
    expect(
      formatBracketedModelDisplayName(
        'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
        'grok-4.7',
      ),
    ).toBe('grok-4.7 (256k · raciocínio: high · fast)');

    expect(
      formatBracketedModelDisplayName(
        'claude-opus-5-5[context=300k,effort=medium,fast=false]',
        'claude-opus-5-5',
      ),
    ).toBe('claude-opus-5-5 (300k · raciocínio: medium)');

    expect(
      formatBracketedModelDisplayName('composer-2.5[fast=true]', 'composer-2.5'),
    ).toBe('composer-2.5 (fast)');

    expect(
      formatBracketedModelDisplayName('gemini-3.1-pro[]', 'gemini-3.1-pro'),
    ).toBe('gemini-3.1-pro');
  });

  it('extracts per-model reasoning_efforts and ACP thought_level config options for Codex', () => {
    const models = extractAvailableModelOptions({
      available_models: [
        {
          id: 'gpt-6.1-sol',
          label: 'GPT-6.1-Sol',
          reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        },
        {
          id: 'gpt-6-luna',
          label: 'GPT-6-Luna',
          reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      ],
    });
    expect(models[0]?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(models[1]?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);

    const cfgReasoning = extractReasoningConfigFromConfigOptions([
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        type: 'select',
        currentValue: null,
        options: [
          { value: 'low', name: 'low' },
          { value: 'medium', name: 'medium' },
          { value: 'high', name: 'high' },
        ],
      },
    ]);
    expect(cfgReasoning).toEqual({
      optionId: 'reasoning_effort',
      currentValue: undefined,
      options: ['low', 'medium', 'high'],
    });
  });

  it('syncs reasoning_effort to AionCore config-options PUT when configuring an active team slot', async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];

    const fetchFn = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url, body });

      if (url.endsWith('/health')) return jsonResponse(REAL_CORE_HEALTH_V022);
      if (url.endsWith('/api/auth/status')) {
        return jsonResponse({ success: true, ...REAL_CORE_AUTH_STATUS_V022 });
      }
      if (url.endsWith('/api/agents/management')) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'codex-1',
              name: 'Codex',
              backend: 'codex',
              installed: true,
              enabled: true,
              status: 'online',
              available_models: {
                available_models: [
                  {
                    id: 'gpt-6.1-sol',
                    label: 'GPT-6.1-Sol',
                    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
                  },
                ],
              },
              config_options: [
                {
                  id: 'reasoning_effort',
                  category: 'thought_level',
                  type: 'select',
                  options: [{ value: 'low' }, { value: 'high' }],
                },
              ],
            },
          ],
        });
      }
      if (url.endsWith('/api/assistants')) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'bare:codex-1',
              name: 'Codex',
              agent_id: 'codex-1',
              enabled: true,
              team_selectable: true,
            },
          ],
        });
      }
      if (url.endsWith('/api/teams') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            id: 'team_r_1',
            name: 'Time Raciocinio',
            assistants: [
              {
                slot_id: 'slot_r_1',
                name: 'Lider',
                role: 'lead',
                conversation_id: 'ext_conv_r_1',
                backend: 'codex',
                model: 'gpt-6.1-sol',
              },
            ],
            created_at: 1,
            updated_at: 1,
          },
        });
      }
      if (
        url.includes('/api/teams/team_r_1/conversations/ext_conv_r_1/config-options/reasoning_effort') &&
        method === 'PUT'
      ) {
        return jsonResponse({
          success: true,
          data: { confirmation: 'observed', config_options: [] },
        });
      }
      if (url.includes('/api/teams/team_r_1/agents/slot_r_1/model') && method === 'PATCH') {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ success: true, data: [] });
    };

    const adapter = new AionCoreAdapter(
      new WorkspacePersistenceManager(new MemoryOnlyStorageDriver()),
      { fetchFn, readCookie: () => 'csrf_r' },
    );

    await adapter.loadWorkspace();
    await adapter.core.checkHealth();
    await adapter.core.checkAuthStatus();
    await adapter.core.refreshCoreCatalog();

    const snap = adapter.getStateSnapshot();
    const codexConn = snap.connections.find((c) => c.coreAssistantId === 'bare:codex-1');
    expect(codexConn?.availableModels[0]?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);

    const proj = await adapter.createProject({
      name: 'Projeto Raciocinio',
      description: 'Teste',
      workspacePathInfo: 'C:/tmp/r',
    });
    const conv = await adapter.createConversation({
      projectId: proj.id,
      title: 'Conv',
      presetId: '__empty__',
    });

    await adapter.addParticipantToConversation(conv.conversation.id, {
      connectionId: codexConn!.id,
      displayName: 'Lider',
      roles: ['coordinator', 'planner', 'executor'],
      modelRef: {
        externalId: 'gpt-6.1-sol',
        displayName: 'GPT-6.1-Sol',
        source: 'core_catalog',
        confirmation: 'confirmed',
      },
      instructions: 'Coordenar.',
    });

    await adapter.core.createCoreTeamForConversation(conv.conversation.id);
    const createdProj = adapter.getStateSnapshot().conversations[conv.conversation.id]!;
    const pId = createdProj.participants[0]!.id;

    await adapter.configureParticipant({
      conversationId: conv.conversation.id,
      participantId: pId,
      modelRef: {
        externalId: 'gpt-6.1-sol',
        displayName: 'GPT-6.1-Sol',
        source: 'core_catalog',
        confirmation: 'confirmed',
        reasoningEffort: 'high',
        reasoningOptionId: 'reasoning_effort',
      },
    });

    const putCall = requests.find(
      (r) =>
        r.method === 'PUT' &&
        r.path.endsWith('/api/teams/team_r_1/conversations/ext_conv_r_1/config-options/reasoning_effort'),
    );
    expect(putCall).toBeDefined();
    expect(putCall?.body).toEqual({ value: 'high' });

    const updatedP = adapter
      .getStateSnapshot()
      .conversations[conv.conversation.id]?.participants[0];
    expect(updatedP?.modelRef.reasoningEffort).toBe('high');
  });
});
