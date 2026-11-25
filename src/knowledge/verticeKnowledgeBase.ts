export type KnowledgeCategoryId =
  | 'arquitetura'
  | 'funcionalidades'
  | 'modos_e_papeis'
  | 'como_usar'
  | 'troubleshooting';

export interface KnowledgeCategory {
  id: KnowledgeCategoryId;
  label: string;
  description: string;
}

export interface KnowledgeArticle {
  id: string;
  category: KnowledgeCategoryId;
  title: string;
  summary: string;
  tags: string[];
  relatedFiles: string[];
  bodyMarkdown: string;
}

export const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = [
  {
    id: 'arquitetura',
    label: 'Arquitetura & Código',
    description: 'Camadas, fluxo de eventos, contratos HTTP/WS e mapa completo de arquivos.',
  },
  {
    id: 'funcionalidades',
    label: 'Funcionalidades',
    description: 'Geral vs abas, contexto versionado, tarefas, auditoria, permissões e backup.',
  },
  {
    id: 'modos_e_papeis',
    label: 'Modos, Papéis & Protocolo',
    description: 'AionCore local, papéis combináveis, catálogo de modelos e envelope aion-desk/v1.',
  },
  {
    id: 'como_usar',
    label: 'Guia de Uso & Setup',
    description: 'Instalação, scripts locais, preparação em 5 etapas e configuração do Assistente.',
  },
  {
    id: 'troubleshooting',
    label: 'Solução de Problemas',
    description: 'Diagnóstico de 401/403 CSRF, 502 Core, WS 1008, gap_detected, paused_queue e storage.',
  },
];

export const VERTICE_KNOWLEDGE_BASE: KnowledgeArticle[] = [
  {
    id: 'arch-layers-and-dataflow',
    category: 'arquitetura',
    title: 'Arquitetura em Camadas e Fluxo de Dados',
    summary:
      'Separação estrita entre UI React, contrato público AgentWorkspaceGateway, AionCoreAdapter, domínio puro (reducer) e persistência IndexedDB.',
    tags: ['arquitetura', 'camadas', 'gateway', 'reducer', 'aioncore', 'indexeddb'],
    relatedFiles: [
      'src/App.tsx',
      'src/features/workspace/WorkspaceContext.tsx',
      'src/services/gateway.ts',
      'src/services/aionCoreAdapter.ts',
      'src/domain/reducer.ts',
      'src/services/storage.ts',
    ],
    bodyMarkdown: `O **Vértice Workspace** (*Powered by AionCore*) segue uma arquitetura em 5 camadas isoladas para impedir que detalhes de transporte HTTP/WS ou formatos externos vazem para a interface:

1. **UI React (\`src/features/*\`, \`src/components/*\`)**:
   - Consome exclusivamente o estado e as ações expostas por \`WorkspaceProvider\` / \`useWorkspace()\` (\`src/features/workspace/WorkspaceContext.tsx\`).
   - Nunca chama \`fetch\`, \`WebSocket\` ou APIs do AionCore diretamente.
2. **Contrato Público (\`src/services/gateway.ts\`)**:
   - Define a interface \`AgentWorkspaceGateway\` e \`CoreGatewayOperations\`, além da classe tipada \`GatewayCapabilityError\` (\`NOT_CONNECTED_LOCAL_CORE\`, \`AUTH_REQUIRED\`, \`CSRF_REJECTED\`, \`TIMEOUT\`, \`INVALID_PAYLOAD\`, \`CAPABILITY_UNSUPPORTED\`, \`VALIDATION_ERROR\`, \`CONVERSATION_NOT_FOUND\`, \`OPERATION_FAILED\`).
3. **Adaptador e Transporte (\`src/services/aionCoreAdapter.ts\`, \`aionCoreTransport.ts\`, \`aionCoreDtos.ts\`)**:
   - \`AionCoreAdapter\` traduz ações da UI para rotas HTTP REST e eventos WebSocket do **AionCore v0.2.2**.
   - \`AionCoreHttpClient\` gerencia cookies \`HttpOnly\`, cabeçalho CSRF \`x-csrf-token\` (cookie \`aionui-csrf-token\`) e renovação *single-flight* em \`401\` via \`POST /api/auth/refresh\`.
   - \`AionCoreWsClient\` conecta em \`/ws\` usando subprotocolo \`[ws_token]\` obtido em \`GET /api/ws-token\`, responde \`ping\`/\`pong\` e dispara *catch-up* automático ao reconectar.
4. **Domínio Puro (\`src/domain/*\`)**:
   - \`types.ts\`: entidades normalizadas (\`Project\`, \`WorkspaceConversation\`, \`Participant\`, \`SessionRef\`, \`Task\`, \`TaskAttempt\`, \`TaskReview\`, \`SharedContextRevision\`, \`PlanRevision\`, \`PermissionRequest\`, \`EscalationDecision\`, \`ExecutionEvent\`).
   - \`reducer.ts\`: \`ingestEvent\` / \`applyEventIncrementally\` garantem deduplicação por \`seenEventIds\`, ordenação contígua por \`seq\` e buffer \`pendingOutOfOrder\` com detecção de lacuna (\`syncState: 'gap_detected'\`).
5. **Persistência & Backup (\`src/services/storage.ts\`, \`src/services/exportService.ts\`)**:
   - \`WorkspacePersistenceManager\` serializa gravações no **IndexedDB** (\`aion_desk_storage\`) com *mutex* e *debounce* (180 ms), degradando honestamente para \`session_only\` (\`Somente nesta sessão\`) em erro de cota.
   - Preferências leves de UI ficam em \`localStorage\` (\`aion_desk_ui_prefs_v1\`).`,
  },
  {
    id: 'arch-codebase-map',
    category: 'arquitetura',
    title: 'Mapa Completo do Código-Fonte e Diretórios',
    summary:
      'Onde fica cada responsabilidade no repositório: src/domain, src/services, src/features, src/knowledge e scripts/.',
    tags: ['codigo', 'estrutura', 'arquivos', 'diretorios', 'mapa', 'scripts'],
    relatedFiles: [
      'src/domain/types.ts',
      'src/domain/presets.ts',
      'src/domain/migration.ts',
      'scripts/vertice-server.mjs',
      'scripts/vertice-ctl.mjs',
      'vite.config.ts',
    ],
    bodyMarkdown: `### Estrutura de diretórios do projeto

- **\`src/config/brand.ts\`**: marca (\`Vértice Workspace\`), slogan, assinatura técnica e versões de schema (\`storageSchemaVersion: 2\`, \`exportSchemaVersion: '2.0.0'\`).
- **\`src/domain/\`** *(lógica pura, sem efeitos colaterais)*:
  - \`types.ts\`: todos os tipos de estado, eventos e configurações.
  - \`reducer.ts\`: projeção incremental de eventos e reconciliação de snapshots/lacunas.
  - \`internalProtocol.ts\`: parser e gerador de prompts do envelope \`aion-desk/v1\` (\`aion-desk-json\`).
  - \`taskRules.ts\`: validação de grafo de dependências (detecção de ciclos e referências inválidas via \`validateTaskInput\`) e desbloqueio (\`areTaskDependenciesSatisfied\`).
  - \`teamValidation.ts\`: resolução de papéis (\`resolveTeamRoles\`), independência do auditor (\`checkAuditIndependence\`) e regras de equipe.
  - \`presets.ts\`: presets iniciais (\`preset_terra_sol_gemini\`, \`preset_terra_sol_split_gemini\`) e estado inicial limpo (\`createInitialWorkspaceState\`).
  - \`migration.ts\`: migração v1 → v2 (\`migrateWorkspaceState\`) e \`IncompatibleSchemaError\`.
  - \`selectors.ts\`: consultas derivadas (última revisão de contexto, contagens de tarefas, pendências).
- **\`src/services/\`**:
  - \`aionCoreAdapter.ts\`, \`aionCoreDtos.ts\`, \`aionCoreTransport.ts\`, \`coreDiagnostics.ts\`, \`gateway.ts\`, \`storage.ts\`, \`exportService.ts\`.
- **\`src/features/\`**:
  - \`workspace/\`: \`WorkspaceContext.tsx\`, \`WorkspaceHeader.tsx\`, \`AgentTabs.tsx\`, \`MessageStream.tsx\`, \`Composer.tsx\`, \`MarkdownView.tsx\`.
  - \`projects/\`: \`ProjectSidebar.tsx\`, \`ProjectDialog.tsx\`.
  - \`inspector/\`: \`InspectorDrawer.tsx\`, \`TasksPanel.tsx\`, \`TaskDetailCard.tsx\`, \`ContextPanel.tsx\`, \`ContextRevisionForm.tsx\`.
  - \`settings/\`: \`SettingsView.tsx\`, \`ParticipantsSection.tsx\`, \`ModelPolicySection.tsx\`, \`AgentCatalogSection.tsx\`.
  - \`assistant/\`: \`VerticeAssistantWidget.tsx\` (Assistente flutuante + Base de Conhecimento + leitor de código).
- **\`scripts/\`** *(runtime Node nativo, 0 dependências externas)*:
  - \`vertice-server.mjs\`: servidor estático \`dist/\` + proxy HTTP/WS para o Core + leitura do código do Assistente.
  - \`vertice-ctl.mjs\`: CLI de ciclo de vida (\`doctor\`, \`start\`, \`status\`, \`stop\`) com token de controle e ACL restritiva no Windows (\`icacls\`).
  - \`vertice-source-reader.mjs\`: leitor somente leitura com allowlist estrita para \`/__vertice_assistant/*\`.
  - \`start-vertice.ps1\`, \`stop-vertice.ps1\`, \`install.ps1\`: automação Windows.`,
  },
  {
    id: 'arch-server-and-security',
    category: 'arquitetura',
    title: 'Servidor Local, Proxy Mesma Origem e Segurança',
    summary:
      'Como vertice-server.mjs, vite.config.ts e vertice-ctl.mjs garantem loopback, cookies HttpOnly, CSRF, ACL NTFS e proteção contra traversal.',
    tags: ['servidor', 'proxy', 'seguranca', 'loopback', 'csrf', 'vertice-ctl', 'acl'],
    relatedFiles: [
      'scripts/vertice-server.mjs',
      'scripts/vertice-ctl.mjs',
      'scripts/vertice-source-reader.mjs',
      'vite.config.ts',
      'vertice.config.json',
    ],
    bodyMarkdown: `### Por que o proxy de mesma origem é essencial

Em operação real, o navegador acessa o **Vértice Workspace** em \`http://127.0.0.1:4173\` (produção via \`npm start\` / \`server:start\`) ou \`http://localhost:3000\` (\`npm run dev\`), enquanto o **AionCore** escuta por padrão em \`http://127.0.0.1:25828\`.

- O proxy encaminha \`/health\`, \`/login\`, \`/logout\`, \`/api/*\` e \`/ws\` para \`VITE_AIONCORE_PROXY_TARGET\`.
- Mantendo \`Base URL\` vazio (\`VITE_AIONCORE_BASE_URL=""\`), todas as requisições permanecem na **mesma origem**, preservando cookies \`HttpOnly\` (\`aionui-session\`) e o cookie \`aionui-csrf-token\` lido por \`AionCoreHttpClient\` para enviar o header \`x-csrf-token\`.

### Endurecimentos implementados
- **Loopback obrigatório**: \`vertice-server.mjs\` recusa bind em \`0.0.0.0\` ou IPs não-loopback por padrão (\`isLoopbackHost\`).
- **Controle autenticado da instância**: \`vertice-ctl.mjs\` gera \`instanceId\` e \`controlToken\` em \`.vertice/server.json\`, restringe ACL no Windows via \`icacls /inheritance:r\`, verifica identidade em \`/__vertice_ctl/identity\` antes de encerrar e nunca mata PIDs alheios. O proxy remove \`x-vertice-control-token\` antes de encaminhar ao Core.
- **Proteção de caminhos**: \`safeDecodePathname\` retorna HTTP \`400\` em URLs malformadas (\`/%ZZ\`, \`%00\`), \`resolveDistFile\` bloqueia travessia/symlinks fora de \`dist/\`, e \`vertice-source-reader.mjs\` restringe leitura estritamente a \`src/\`, \`docs/\`, \`scripts/\` e arquivos raiz permitidos.`,
  },
  {
    id: 'feat-general-vs-tabs-and-context',
    category: 'funcionalidades',
    title: 'Aba Geral, Abas Individuais e Contexto Compartilhado Versionado',
    summary:
      'Diferença entre coordenar na aba Geral, conversar diretamente na aba de um participante e publicar revisões rastreáveis de Contexto Compartilhado.',
    tags: ['geral', 'abas', 'contexto', 'recibos', 'rascunho', 'coordenador'],
    relatedFiles: [
      'src/features/workspace/AgentTabs.tsx',
      'src/features/workspace/Composer.tsx',
      'src/features/inspector/ContextPanel.tsx',
      'src/features/inspector/ContextRevisionForm.tsx',
      'src/i18n/ptBR.ts',
    ],
    bodyMarkdown: `### Aba Geral vs. Abas Individuais

- **Aba \`Geral\`**:
  - Exibe a linha do tempo consolidada (\`generalFeed\`) com pedidos do usuário, planos publicados, delegações, entregas, pareceres de auditoria, revisões de contexto, permissões e escalonamentos.
  - Mensagens enviadas na \`Geral\` são encaminhadas ao **Coordenador atual** (\`POST /api/teams/{id}/messages\`), e **não** atualizam os demais agentes sozinhas sem delegação ou Contexto Compartilhado.
- **Abas individuais (por participante)**:
  - Cada participante possui \`Participant.id\`, \`SessionRef\` (\`externalSlotId\`, \`externalConversationId\`, \`nativeSessionId\`), histórico (\`messagesByTab[participantId]\`), rascunho independente e posição de scroll salvos por aba.
  - Enviar por uma aba individual dispara \`POST /api/teams/{id}/agents/{slot_id}/messages\` diretamente àquela sessão.

### Contexto Compartilhado Versionado e Recibos Granulares
- A fonte de verdade do projeto no Vértice é \`SharedContextRevision\` (\`v1\`, \`v2\`...), contendo objetivo, instruções permanentes, restrições, critérios de aceitação e decisões confirmadas.
- **Honestidade semântica**: enviar uma revisão não significa que o modelo já a aplicou. Cada participante mantém um \`ContextReceipt\` individual com estados monotônicos:
  1. \`pending_send\`: revisão publicada localmente, ainda não enviada na próxima mensagem ao slot.
  2. \`sent\`: incluída no payload enfileirado para o Core (\`ack.message_id\`).
  3. \`received\`: turno do agente iniciado/recebido pelo Core.
  4. \`applied\`: resposta/entrega correlacionada concluída com sucesso.
  5. \`failed_needs_action\`: falha no envio para aquele participante.`,
  },
  {
    id: 'feat-tasks-audit-escalation',
    category: 'funcionalidades',
    title: 'Tarefas, Dependências, Auditoria Independente e Escalonamento',
    summary:
      'Ciclo de vida completo de tarefas, limite de tentativas (3), separação entre falha operacional e reprovação de qualidade e política de escalonamento.',
    tags: ['tarefas', 'dependencias', 'auditoria', 'revisao', 'escalonamento', 'tentativas'],
    relatedFiles: [
      'src/domain/taskRules.ts',
      'src/domain/teamValidation.ts',
      'src/features/inspector/TasksPanel.tsx',
      'src/features/inspector/TaskDetailCard.tsx',
      'src/features/settings/ModelPolicySection.tsx',
      'src/components/EscalationBanner.tsx',
    ],
    bodyMarkdown: `### Fluxo de Tarefas e Dependências
1. **Planejamento**: \`PlanRevision\` registra versões imutáveis do plano vinculando \`taskIds\`.
2. **Validação de Grafo (\`validateTaskInput\`)**: impede dependências inexistentes, auto-dependência e ciclos no grafo de tarefas.
3. **Despacho Serializado no Core**: \`dispatchNextRunnableTaskInCore\` em \`AionCoreAdapter\` escolhe a próxima tarefa \`planned\`/\`queued\` ou \`changes_requested\` cujas dependências estejam todas em \`completed\` (\`areTaskDependenciesSatisfied\`), evitando conflitos de escrita simultânea no mesmo diretório.

### Tentativas, Qualidade vs. Falha Operacional
- Cada execução cria um \`TaskAttempt\` registrando \`executorParticipantId\`, \`modelRefUsed\`, \`rolesSnapshot\`, \`instructionsSnapshot\` e \`contextRevisionNumber\` daquele momento (alterações futuras de configuração nunca reescrevem tentativas passadas).
- **Teto de tentativas**: \`MAX_CORE_TASK_ATTEMPTS = 3\` protege contra loops infinitos.
- **Separação estrita**:
  - \`qualityRejectionCount\`: incrementa **apenas** quando o auditor rejeita a entrega por critérios não atendidos (\`review_decision.decision === 'rejected'\`).
  - \`operationalFailureCount\`: incrementa em quedas, erros de CLI, timeout ou cancelamentos — **não** conta para escalonamento de modelo por qualidade.

### Auditoria Independente e Escalonamento (\`ModelPolicy\`)
- \`checkAuditIndependence\` verifica se o auditor (\`reviewerParticipantId\`) possui sessão distinta do executor e do planejador.
- Quando \`qualityRejectionCount >= modelPolicy.qualityRejectionsBeforeSuggest\`, o sistema cria uma \`EscalationDecision\` (\`suggested\`), respeitando \`approvalMode\`: \`manual\` (exige aprovação do usuário no \`EscalationBanner\`) ou \`auto_policy\` (promove automaticamente via \`PATCH /api/teams/{id}/agents/{slot_id}/model\`).`,
  },
  {
    id: 'feat-permissions-and-backup',
    category: 'funcionalidades',
    title: 'Permissões Nativas do Core, Exportação e Backup Restaurável',
    summary:
      'Como funcionam confirmações de ferramenta (acp_permission), exportação Markdown/JSON 2.0.0 sem segredos e modos de importação.',
    tags: ['permissoes', 'acp_permission', 'backup', 'exportar', 'importar', 'json'],
    relatedFiles: [
      'src/components/PermissionCard.tsx',
      'src/components/ExportDialog.tsx',
      'src/services/exportService.ts',
      'src/domain/migration.ts',
    ],
    bodyMarkdown: `### Permissões do Core (\`acp_permission\`)
- Quando uma CLI no AionCore precisa executar uma ação sensível (ex.: gravar arquivo ou rodar comando), emite \`message.stream\` com \`type: 'acp_permission'\`.
- O Vértice exibe um \`PermissionCard\` com escopo exato (\`participantId\`, \`actionKey\`, \`scopeKey\`, \`taskId\`).
- Ao clicar em **Aprovar** ou **Recusar**, o adaptador envia \`POST /api/conversations/{extConvId}/confirmations/{callId}/confirm\` com \`always_allow\` mantido conservadoramente desabilitado na v1.

### Backup Versionado (\`exportSchemaVersion: "2.0.0"\`)
- **Exportar / Backup**: gera JSON completo do workspace (ou Markdown legível da conversa ativa).
- **Segurança**: cookies, senhas, tokens Bearer/CSRF/WS e estados \`authenticated\`/\`active\` de sessão **nunca** são incluídos no arquivo exportado.
- **Importação segura (\`parseAndValidateWorkspaceBackup\`)**:
  - Valida estrutura e versão de schema antes de tocar no estado atual.
  - Oferece preview com contadores e escolha explícita entre **Importar como cópia** (remapeia todos os IDs para não colidir e preserva a sessão atual) ou **Substituir workspace atual**.
  - Vínculos externos (\`externalTeamId\`, \`slot_id\`, \`externalConversationId\`) são desvinculados para \`importedExternalTeamId\` / \`importedExternalRef\`, exigindo nova vinculação consciente sem disparo automático de execução.`,
  },
  {
    id: 'modes-roles-and-protocol',
    category: 'modos_e_papeis',
    title: 'Modos de Operação, Papéis Combináveis e Protocolo aion-desk/v1',
    summary:
      'Funcionamento do Modo AionCore local, mapeamento lead/teammate, múltiplas sessões do mesmo provedor e contrato textual aion-desk-json.',
    tags: ['modos', 'papeis', 'coordenador', 'planejador', 'executor', 'auditor', 'aion-desk/v1'],
    relatedFiles: [
      'src/domain/internalProtocol.ts',
      'src/domain/teamValidation.ts',
      'src/features/settings/ParticipantsSection.tsx',
      'src/features/settings/AgentCatalogSection.tsx',
    ],
    bodyMarkdown: `### Modo de Operação
- O Vértice opera em **Modo AionCore local** (\`executionMode: 'aion_core'\`), comunicando via HTTP/WS com o binário \`aioncore.exe v0.2.2\` sem simulador fictício quando o Core está indisponível.

### Papéis Combináveis e Múltiplas Sessões
- Cada participante na conversa pode combinar papéis: \`coordinator\` (Coordenador), \`planner\` (Planejador), \`executor\` (Executor) e \`reviewer\` (Auditor / Revisor).
- No AionCore (\`POST /api/teams\`), o coordenador é mapeado para \`role: 'lead'\` e os demais para \`role: 'teammate'\`.
- É possível adicionar **múltiplas sessões da mesma conexão/CLI** (por exemplo, dois participantes no provedor \`Codex\` com modelos diferentes, como coordenador e planejador/auditor) — cada um recebe \`slot_id\` e \`conversation_id\` próprios.
- Nomes de preset como \`Terra 6.1\`, \`Sol 6.1\` e \`Gemini Hydrogen\` são rótulos iniciais/preferências (\`unverified_preference\`) até serem resolvidos para IDs confirmados do catálogo Core.

### Contrato Interno \`aion-desk/v1\`
- Em equipes multi-participantes, \`composeCoreOutgoingContent\` instrui os agentes a incluir um bloco delimitado por \`\`\`aion-desk-json ... \`\`\` com \`protocol: "aion-desk/v1"\` e um dos três tipos:
  - \`plan_proposal\` (cria plano + tarefas com dependências);
  - \`delivery_report\` (registra entrega da tentativa e aciona o auditor);
  - \`review_decision\` (\`approved\` ou \`rejected\` com critérios não atendidos).
- Se o agente responder em texto livre sem bloco válido, o parser marca \`parseStatus: 'incomplete' | 'invalid'\`, mantém o texto bruto visível e encaminha para **revisão manual**, sem concluir a tarefa automaticamente.`,
  },
  {
    id: 'howto-setup-and-assistant',
    category: 'como_usar',
    title: 'Guia Passo a Passo: Instalação, Conexão Real e Assistente',
    summary:
      'Como preparar o ambiente Windows/Linux, conectar o AionCore em 5 etapas e ativar o Assistente Flutuante após sincronizar o primeiro provedor.',
    tags: ['como usar', 'instalacao', 'configuracao', 'etapas', 'assistente', 'login'],
    relatedFiles: [
      'README.md',
      'docs/local-validation.md',
      'src/features/settings/SettingsView.tsx',
      'scripts/start-vertice.ps1',
      'vertice.config.json',
    ],
    bodyMarkdown: `### 1. Subindo o Vértice + AionCore localmente
- **Windows (atalho rápido)**:
  1. Execute \`install.cmd\` na primeira vez (instala pacotes, gera \`dist/\` e valida \`aioncore.exe v0.2.2\` em \`.vertice/bin/\`).
  2. Execute \`Iniciar Vertice.cmd\` (inicia o AionCore em \`127.0.0.1:25828\` com dados externos em \`%LOCALAPPDATA%\\VerticeWorkspace\` e sobe o servidor web em \`http://127.0.0.1:4173\`).
  3. Para encerrar com segurança, use \`Parar Vertice.cmd\`.
- **Via terminal (\`npm\`)**:
  - Desenvolvimento: \`npm run dev\` (porta \`3000\`, proxy configurado por \`VITE_AIONCORE_PROXY_TARGET\` em \`.env.local\`).
  - Produção local: \`npm run build && npm run server:doctor && npm run server:start\`.

### 2. Preparação guiada em Configurações (5 etapas)
1. **Conectar runtime local**: clique em **Verificar /health** (\`GET /health\`).
2. **Autenticar sessão local**: faça login no formulário WebUI (\`POST /login\`) — as credenciais nunca são gravadas no IndexedDB.
3. **Verificar agentes e modelos**: clique em **Sincronizar catálogo** (\`GET /api/agents/management\` + \`GET /api/assistants\`).
   - *Neste momento, assim que houver ao menos 1 conexão com modelo confirmado, o **Chat IA do Assistente Flutuante** já pode ser ativado!*
4. **Escolher workspace e criar equipe**: crie um projeto/conversa, informe o caminho do workspace alvo e clique em **Criar time da conversa no Core** (\`POST /api/teams\`).
5. **Conectar WebSocket e enviar primeiro pedido**: clique em **Conectar WebSocket** e envie uma solicitação pela aba **Geral**.`,
  },
  {
    id: 'troubleshooting-common-errors',
    category: 'troubleshooting',
    title: 'Diagnóstico e Solução de Erros Comuns (HTTP, CSRF, WS e Sync)',
    summary:
      'Referência rápida para diagnosticar 502 Bad Gateway, 401, 403 CSRF, WS 1008, gap_detected, paused_queue e storage session_only.',
    tags: ['erro', '502', '401', '403', 'csrf', 'ws', '1008', 'paused_queue', 'gap_detected', 'doctor'],
    relatedFiles: [
      'src/services/aionCoreTransport.ts',
      'src/services/aionCoreAdapter.ts',
      'src/services/coreDiagnostics.ts',
      'scripts/vertice-ctl.mjs',
      'src/App.tsx',
    ],
    bodyMarkdown: `### Tabela de diagnóstico rápido

| Sintoma / Código | Causa provável | Como resolver |
| :--- | :--- | :--- |
| **HTTP 502 / Core inacessível** | \`aioncore.exe\` parado ou porta divergente de \`VITE_AIONCORE_PROXY_TARGET\` | Rode \`npm run server:doctor\`, confirme se o Core escuta na porta configurada (\`vertice.config.json\` / \`.env.local\`, padrão \`25828\`) e inicie via \`Iniciar Vertice.cmd\`. |
| **401 AUTH_REQUIRED** | Sessão WebUI não autenticada ou expirada (mesmo após \`/api/auth/refresh\`) | Em **Configurações → Conexão AionCore Local**, faça login novamente em \`/login\`. |
| **403 CSRF_REJECTED** | \`Base URL\` preenchido causando origem cruzada ou cookie \`aionui-csrf-token\` ausente | Deixe **Base URL** vazio para usar o proxy na mesma origem (\`127.0.0.1:4173\` ou \`localhost:3000\`) e refaça o login. |
| **WS fechado com código 1008** | Token/sessão WebSocket expirada | O cliente tenta \`refreshSession()\`; se recusado, autentique novamente e clique em **Conectar WebSocket**. |
| **Catálogo vazio / CLI \`missing\` ou \`unauthenticated\`** | CLI (\`codex\`, \`cursor-agent\`, \`agy\`) não instalada no PATH ou não autenticada no SO | Instale/autentique a CLI no ambiente local do usuário, reinicie o Core se necessário e clique em **Sincronizar catálogo**. |
| **Banner \`paused_queue\` após reload** | Página recarregada enquanto havia execução ativa | Não reenvie o pedido! Clique em **Reconciliar agora** e depois em **Retomar fluxo** para continuar só das etapas pendentes. |
| **\`gap_detected\` ou \`incomplete\`** | Eventos fora de ordem ou falha parcial no *catch-up* (\`/run-state\`, \`/mailbox\`, \`/tasks\`, \`/activity\`) | Verifique conexão/autenticação no Core e clique em **Reconciliar agora**. |
| **\`Somente nesta sessão\`** | IndexedDB bloqueado (aba anônima restrita) ou \`QuotaExceededError\` | Exporte um **Backup JSON** imediatamente pelo botão **Exportar / Backup** para não perder o trabalho ao fechar a aba. |`,
  },
];
