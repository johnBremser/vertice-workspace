# Backlog de Melhorias — Vértice Workspace

Registro priorizado de evoluções planejadas fora do escopo mínimo já entregue.

---

## BL-01 — Política de aprovação automática de ferramentas por conversa (`acp_permission`)

- **Status:** Planejado (aguardando implementação)
- **Prioridade:** Alta (usabilidade em fluxos longos com agentes ACP, como `cursor-agent`)
- **Origem:** Relato de uso real (27/11/2026) — agentes ACP solicitam confirmação (`acp_permission`) repetidamente para leitura, edição e execução de comandos durante uma mesma tarefa.

### Problema atual

Hoje em [src/services/aionCoreAdapter.ts](../src/services/aionCoreAdapter.ts), toda solicitação `acp_permission` recebida via WebSocket exige clique manual no card **Aprovar / Recusar** ([MessageStream.tsx](../src/features/workspace/MessageStream.tsx)) e envia `POST /api/conversations/{extConvId}/confirmations/{callId}/confirm` com `always_allow: false` fixo (escolhendo `allow_once`). Não existe configuração por conversa para aprovar ferramentas automaticamente.

### Escopo proposto

1. **Modelo de domínio e persistência (`WorkspaceConversation`)**
   - Adicionar campo opcional `toolApprovalPolicy?: 'manual' | 'allow_read_edit' | 'allow_all_in_conversation'` em `WorkspaceConversation` (`src/domain/types.ts` e `src/domain/presets.ts`), com padrão seguro **`'manual'`**.
   - **Regra de segurança na recarga/importação (`storage.ts` / `exportService.ts`)**: `sanitizeLoadedStateAfterReload()` e `applyImportedWorkspaceBackup()` devem **reverter `allow_all_in_conversation` para `'manual'`** ao recarregar a página ou importar backup (evitando aprovação silenciosa herdada sem ciência explícita do usuário), ou registrar banner claro caso uma política menos permissiva seja restaurada.

2. **Controle na interface da conversa**
   - Exibir seletor compacto/botão de estado no cabeçalho ou compositor da conversa (ou em **Configurações → Equipe/Conversa ativa**), indicando claramente o modo ativo:
     - **Manual (padrão):** pergunta antes de cada ação (`allow_once`, `always_allow: false`).
     - **Auto-aprovar leitura/edição no workspace:** aprova automaticamente `acp_permission` cujo `tool_call.kind` / `command_type` seja apenas leitura ou edição dentro do workspace; comandos shell/destrutivos continuam exigindo clique manual.
     - **Auto-aprovar nesta conversa (sessão atual):** aprova automaticamente pedidos `acp_permission` recebidos enquanto a aba estiver aberta e ativa, exigindo confirmação explícita ao ativar (modal/aviso destacando que volta para `manual` ao recarregar).
   - No próprio card de permissão pendente, oferecer botão secundário **"Aprovar sempre este tipo nesta conversa"** (utilizando `allowAlwaysData` quando o agente expor opção `kind: 'allow_always'`, mantendo `always_allow` restrito à decisão explícita).

3. **Adaptador AionCore (`src/services/aionCoreAdapter.ts`)**
   - Guardar `allowAlwaysData` além de `allowOnceData` ao parsear `acp_permission.options`.
   - Ao receber `acp_permission` na conversa ativa com `executionStatus !== 'paused_queue'`:
     - se a política da conversa permitir auto-aprovação para aquele `kind` (e não houver uma recusa prévia não superada no mesmo `actionKey + scopeKey`), responder automaticamente ao Core via `/confirmations/{callId}/confirm` e registrar evento auditável `permission_decided` (`decidedBy: 'Política automática da conversa'`) no feed **Geral** e na aba do participante — **nunca** suprimir trilha de auditoria.
   - Nunca aplicar auto-aprovação no **Assistente Vértice** (`VerticeAssistantWidget`, que permanece estritamente somente leitura e continua bloqueando escrita/execução).

4. **Critérios de aceitação e testes**
   - Testes unitários em `aionCoreAdapter.test.ts` e `v4DomainAndMigration.test.ts` cobrindo:
     1. Padrão inicial `'manual'` mantém confirmação manual obrigatória.
     2. `'allow_read_edit'` aprova `read`/`edit` automaticamente e **continua bloqueando** `execute` (comandos).
     3. `'allow_all_in_conversation'` aprova via HTTP `/confirm`, gera trilha `permission_decided` auditável, **respeita recusa prévia** (`isPermissionStillBlocked`) e é revertido para `'manual'` no reload/backup (`sanitizeLoadedStateAfterReload`).
     4. Assistente flutuante nunca herda auto-aprovação de escrita.

---

## BL-02 — Lista de arquivos alterados e visualização de diff do workspace

- **Status:** Planejado (aguardando implementação)
- **Prioridade:** Alta (visibilidade direta do resultado das entregas e revisões sem sair do Vértice)
- **Origem:** Relato de uso real (27/11/2026) — após os agentes executarem e auditarem tarefas no projeto, falta um painel no Vértice listando quais arquivos foram criados/modificados/removidos e exibindo o diff de cada arquivo.

### Problema atual

Hoje o Vértice exibe o histórico de mensagens, tarefas, revisões e Contexto Compartilhado na gaveta **Trabalho** ([InspectorDrawer.tsx](../src/features/inspector/InspectorDrawer.tsx)), mas não mostra a lista de arquivos alterados no diretório do projeto (`workspacePathInfo`) nem o diff linha a linha das mudanças feitas pelos agentes.

### Escopo proposto

1. **Endpoints somente leitura no servidor local (`scripts/vertice-server.mjs` + middleware dev no `vite.config.ts`)**
   - Expor rotas estritamente somente leitura restritas ao `workspacePathInfo` configurado no projeto ativo (com validação anti-path-traversal e bloqueio de arquivos sensíveis como `.env`, chaves privadas e credenciais):
     - `GET /__vertice_workspace/changes?workspace=<path>`:
       - Quando o workspace for um repositório Git: executa `git status --porcelain=v1 -uall` e `git diff --numstat` (mais contagem de linhas para arquivos novos não rastreados) retornando lista estruturada `{ path, status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked', additions, deletions }`.
       - Fallback quando o diretório **não** for Git: lista arquivos modificados recentemente no workspace (indicando claramente `mode: 'filesystem_recent'` sem fingir diff Git).
     - `GET /__vertice_workspace/diff?workspace=<path>&file=<relPath>`:
       - Retorna o diff unificado (`git diff -- <relPath>`, ou conteúdo novo formatado como adição para arquivos `untracked`, com limite seguro de tamanho/linhas e detecção de arquivo binário).

2. **Nova aba "Arquivos" na gaveta Trabalho (`InspectorDrawer.tsx`)**
   - Adicionar aba **Arquivos** (com contador de arquivos alterados, ex.: `Arquivos (4)`) ao lado de **Tarefas** e **Contexto compartilhado**.
   - Exibir:
     - lista clicável de arquivos com badge de status (`Novo`, `Modificado`, `Removido`), contagem `+linhas / -linhas` e botão **Atualizar** (com atualização automática ao concluir uma entrega `delivery_report` ou revisão `review_decision`);
     - visualizador de diff com destaque visual para linhas adicionadas (`+`) e removidas (`-`), suporte a tema claro/escuro e botão para copiar caminho/diff.

3. **Critérios de aceitação e testes**
   - Testes automatizados cobrindo:
     1. Detecção de arquivos modificados, adicionados (`untracked`) e removidos em repositório Git real temporário.
     2. Fallback honesto quando o workspace não possui `.git`.
     3. Bloqueio de path traversal (`../`) e de arquivos sensíveis (`.env`, `*.pem`, `*.key`) com HTTP `403`/`400`.
     4. Renderização do diff na gaveta **Trabalho** sem quebrar layout em viewport desktop/mobile.
