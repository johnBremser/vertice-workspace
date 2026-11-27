# Backlog de Melhorias — Vértice Workspace

Registro priorizado de evoluções planejadas fora do escopo mínimo já entregue.

Índice e convenção de organização: [Backlog](README.md). Itens concluídos podem ser retirados desta lista após registrar a entrega e as verificações na documentação correspondente.

---

## BL-01 — Política de aprovação automática de ferramentas por conversa (`acp_permission`)

- **Status:** Implementado (27/11/2026)
- **Prioridade:** Alta (usabilidade em fluxos longos com agentes ACP, como `cursor-agent`)
- **Origem:** Relato de uso real (27/11/2026) — agentes ACP solicitam confirmação (`acp_permission`) repetidamente para leitura, edição e execução de comandos durante uma mesma tarefa.
- **Entrega:** `ConversationToolApprovalPolicy` em [src/domain/types.ts](../../src/domain/types.ts), regras fail-closed e checagem de recusa prévia em [src/domain/taskRules.ts](../../src/domain/taskRules.ts), reversão segura de `allow_all_in_conversation` em [src/services/storage.ts](../../src/services/storage.ts) e [src/services/exportService.ts](../../src/services/exportService.ts), auto-aprovação auditável e `allowAlways` em [src/services/aionCoreAdapter.ts](../../src/services/aionCoreAdapter.ts), controle com modal de confirmação em [src/features/workspace/Composer.tsx](../../src/features/workspace/Composer.tsx) e botão secundário em [src/components/PermissionCard.tsx](../../src/components/PermissionCard.tsx).

### Problema atual

Hoje em [src/services/aionCoreAdapter.ts](../../src/services/aionCoreAdapter.ts), toda solicitação `acp_permission` recebida via WebSocket exige clique manual no card **Aprovar / Recusar** ([MessageStream.tsx](../../src/features/workspace/MessageStream.tsx)) e envia `POST /api/conversations/{extConvId}/confirmations/{callId}/confirm` com `always_allow: false` fixo (escolhendo `allow_once`). Não existe configuração por conversa para aprovar ferramentas automaticamente.

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

- **Status:** Implementado (27/11/2026)
- **Prioridade:** Alta (visibilidade direta do resultado das entregas e revisões sem sair do Vértice)
- **Origem:** Relato de uso real (27/11/2026) — após os agentes executarem e auditarem tarefas no projeto, falta um painel no Vértice listando quais arquivos foram criados/modificados/removidos e exibindo o diff de cada arquivo.
- **Entrega:** módulo somente leitura [scripts/vertice-workspace-diff.mjs](../../scripts/vertice-workspace-diff.mjs) integrado a [scripts/vertice-server.mjs](../../scripts/vertice-server.mjs) e [vite.config.ts](../../vite.config.ts), cliente [src/services/workspaceDiffClient.ts](../../src/services/workspaceDiffClient.ts), aba **Arquivos** em [src/features/inspector/FilesPanel.tsx](../../src/features/inspector/FilesPanel.tsx) e [src/features/inspector/InspectorDrawer.tsx](../../src/features/inspector/InspectorDrawer.tsx), e suíte em [src/services/__tests__/workspaceDiff.test.ts](../../src/services/__tests__/workspaceDiff.test.ts).

### Problema atual

Hoje o Vértice exibe o histórico de mensagens, tarefas, revisões e Contexto Compartilhado na gaveta **Trabalho** ([InspectorDrawer.tsx](../../src/features/inspector/InspectorDrawer.tsx)), mas não mostra a lista de arquivos alterados no diretório do projeto (`workspacePathInfo`) nem o diff linha a linha das mudanças feitas pelos agentes.

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

---

## Plano de estabilização e manutenção (27/11/2026)

Os itens BL-03 a BL-09 complementam as melhorias funcionais existentes. Foram definidos a partir da análise independente do workspace e da conferência dos pontos principais no código. Todos estão **planejados**; sua inclusão no backlog não representa implementação nem validação concluída.

**Ordem recomendada:** BL-03 → BL-04 → BL-05 → BL-06 → BL-07 → BL-08 → BL-09. BL-08 pode ser antecipado se uma falha concreta de recuperação exigir correção. A compactação de histórico (BL-09) depende das medições e dos contratos de recuperação; não deve ser tratada como uma poda simples de arrays.

### Orientações para execução

- Preservar as alterações locais e as entregas em andamento de BL-01/BL-02; conferir o estado atual antes de modificar arquivos compartilhados.
- Trabalhar em entregas pequenas e registrar, em cada item, implementação, verificações executadas, evidências e limitações. Atualizar a documentação afetada junto com a mudança.
- Usar Node compatível com `engines.node`, registrar versões e estabelecer a referência inicial com `npm run lint`, `npm test` e `npm run build`. Executar testes relevantes durante cada entrega e as verificações completas ao concluir o conjunto; repetir quando houver alterações, falhas ou dúvidas concretas que justifiquem.
- Distinguir testes com fixtures, navegador e integração com Core/CLIs reais. Uma modalidade de validação não comprova automaticamente as demais.
- Submeter mudanças de persistência, correlação e recuperação à revisão independente antes de considerá-las concluídas.
- Preservar IDs, permissões, recibos de contexto, isolamento entre participantes e correlação tarefa/tentativa/revisão. Manter os identificadores de protocolo e persistência necessários à compatibilidade.

---

## BL-03 — Ambiente reproduzível, diagnóstico de Node e documentação atual

- **Status:** Planejado (27/11/2026)
- **Prioridade:** Alta
- **Dependências:** Nenhuma; estabelecer a referência após incorporar as entregas em andamento.
- **Origem:** Revisão da análise independente e plano de estabilização (27/11/2026).

### Problema e escopo

O Node do terminal pode divergir do runtime compatível usado pelo instalador. Há diagnóstico de versão em `vertice-ctl`, mas os comandos diretos ainda podem chegar a falhas pouco claras nas dependências. A arquitetura documentada também descreve componentes de demonstração ausentes, e o README contém uma contagem fixa de testes que envelhece.

1. Conferir o checkout e as alterações locais; registrar Node/npm, comandos, resultados e limitações da referência inicial, sem declarar integração real apenas com base na suíte automatizada.
2. Centralizar a regra de compatibilidade de Node e reutilizá-la nos caminhos de instalação, desenvolvimento, testes, build e diagnóstico aplicáveis. Fazer a verificação antecipada produzir mensagem clara; não mudar globalmente o ambiente do usuário para resolver a seleção de runtime do projeto.
3. Atualizar [architecture.md](../architecture.md) e [README.md](../../README.md) para refletir criação do gateway, operação exclusiva com Core real, recuperação após reconexão e paginação em memória. Remover a contagem fixa de testes do texto de orientação.
4. Explicar os identificadores legados preservados por compatibilidade, distinguindo marca do produto, protocolo, armazenamento e nomes definidos pelo Core.
5. Preservar os registros históricos de validação como históricos; corrigir os documentos que orientam o uso atual.

### Critérios de aceitação

- Os caminhos e componentes descritos na arquitetura atual existem e correspondem ao comportamento implementado.
- Os comandos documentados executam com runtime suportado; runtime incompatível recebe diagnóstico legível antes das falhas das dependências, nos caminhos cobertos.
- Instalação, comandos diretos e `doctor` concordam sobre a faixa suportada, incluindo seus limites de versão.
- A referência de tipos, testes e build está registrada com versões e resultados reais.

---

## BL-04 — Medição de desempenho do fluxo completo e do armazenamento

- **Status:** Planejado (27/11/2026)
- **Prioridade:** Alta
- **Dependências:** BL-03.
- **Origem:** Crescimento do histórico e cobertura limitada do benchmark atual de 2.000 eventos.

### Problema e escopo

O benchmark atual mede principalmente ingestão no reducer em memória. Ele não estabelece um limite prático de uso nem mede o custo acumulado de notificações do adaptador, clonagem e persistência do workspace.

1. Criar cenários reproduzíveis de 2.000, 10.000 e 25.000 eventos, combinando mensagens, progresso, alterações de tarefas e múltiplos participantes/conversas. Documentar tamanho dos payloads e frequência de chegada.
2. Medir processamento/deduplicação, clonagem, quantidade e duração das gravações, tamanho do estado persistido e carregamento/recuperação do histórico. Registrar memória quando a ferramenta permitir uma medição confiável.
3. Incluir um cenário pelo caminho real do adaptador e outro com IndexedDB no navegador; identificar explicitamente o uso de eventos sintéticos e fixtures nesses cenários.
4. Comparar rajadas e fluxo contínuo, abas ativas/ocultas e carregamento de mensagens anteriores. A UI começa com 40 itens, mas o limite visível aumenta ao carregar anteriores; verificar o comportamento efetivo.
5. Registrar máquina, runtime, condições e resultados. Definir limites de regressão a partir da referência medida, evitando um teto arbitrário de eventos suportados ou assertions de tempo excessivamente sensíveis à máquina.

### Critérios de aceitação

- É possível reproduzir e comparar os resultados antes/depois das otimizações.
- O relatório separa reducer, adaptador, clonagem, gravação e recuperação, identificando os custos dominantes e as limitações da medição.
- Além do tempo, os cenários verificam integridade: sequência final, ausência de duplicações, estado das tarefas e conteúdo recuperado.

---

## BL-05 — Consolidação de snapshots e redução do custo de persistência

- **Status:** Planejado (27/11/2026)
- **Prioridade:** Alta
- **Dependências:** BL-04.
- **Origem:** `scheduleSave` clona o workspace antes do debounce; sucessivas notificações podem repetir esse custo mesmo quando apenas a última versão será gravada.

### Escopo proposto

1. Consolidar alterações antes da preparação do snapshot para escrita, reduzindo clonagens integrais descartadas pelo debounce.
2. Definir e preservar a consistência do snapshot durante alterações concorrentes com uma gravação. Manter serialização, controle de gerações e semântica de `flushSave`.
3. Verificar chamadas de notificação/salvamento para evitar trabalho sem mudança efetiva. Decidir sobre persistência incremental apenas se as medições justificarem o custo e a migração necessários.
4. Preservar o estado mais recente em memória, o indicador de durabilidade e a exportação em caso de falha de armazenamento.

### Critérios de aceitação

- As medições de BL-04 mostram redução de clonagens/trabalho repetido e seu impacto no fluxo completo.
- Testes cobrem rajadas, atualização durante gravação, flush com escrita em andamento e falha de quota/driver.
- Ao esvaziar a fila com sucesso, a versão persistida corresponde à última alteração solicitada; uma escrita antiga não substitui silenciosamente a mais recente.
- Recarga após gravação bem-sucedida preserva o estado; após falha, a exportação contém as alterações mantidas em memória e a interface informa a durabilidade real.

---

## BL-06 — Limpeza dos contratos, do modo demo residual e do Skeleton

- **Status:** Planejado (27/11/2026)
- **Prioridade:** Média
- **Dependências:** BL-03; aplicar em mudanças separadas para facilitar revisão.
- **Origem:** Divergência entre o contrato atual e a operação exclusiva com AionCore.

### Escopo proposto

1. Confirmar todos os usos de `AionCoreAdapterSkeleton`; mover a implementação para suporte de testes ou removê-la se redundante, mantendo verificações úteis de indisponibilidade.
2. Encerrar `demo` como opção operacional nos tipos e caminhos ativos, incluindo fallback das configurações e `setExecutionMode`. Definir tratamento explícito para estado/backups antigos, separando tipos legados dos tipos de execução quando necessário.
3. Preservar dados antigos úteis durante migração ou informar incompatibilidades específicas. Não apagar genericamente histórico, conexões ou flags apenas por terem origem legada.
4. Renomear `getPaginatedEvents` para representar metadados, ou implementar um contrato que realmente devolva uma página. Documentar a diferença entre paginação visual e carregamento de dados.
5. Revisar `core?`, `dispatchTask?`, `connectWebSocket` e `ensureWebSocketConnected`: explicitar obrigatoriedade/capacidades e as diferenças entre conexão explícita e garantia de conexão existente. Preservar o comportamento de recuperação.
6. Manter o discriminador do gateway coerente com o produto integrado ao Core; ampliar abstrações somente quando houver um caso concreto que as exija.

### Critérios de aceitação

- O produto abre e opera em modo Core, com estados de indisponibilidade explícitos e sem simulador introduzido como fallback.
- Migração/importação de dados antigos têm comportamento definido e testes que verificam preservação ou rejeição explícita, sem conversão silenciosa de execução simulada em execução real.
- Os métodos descrevem os dados que retornam e a UI consome o contrato revisado sem perder conexão, reconexão ou carregamento de histórico.
- O Skeleton não permanece no módulo de produção apenas por conveniência dos testes, se confirmado esse uso exclusivo.

---

## BL-07 — Extração gradual de responsabilidades do AionCoreAdapter

- **Status:** Planejado (27/11/2026)
- **Prioridade:** Média
- **Dependências:** BL-06; considerar os resultados de BL-04/BL-05 para preservar os caminhos de desempenho.
- **Origem:** Concentração de transporte coordenado, normalização, prompts, tarefas, permissões e recuperação em um único adaptador extenso.

### Escopo proposto

1. Mapear responsabilidades, dependências e autoridade sobre o estado antes das extrações. Manter `AionCoreAdapter` como fachada do gateway.
2. Extrair composição de prompts e normalização de eventos; depois, sincronização de equipes e coordenação de tarefas. Tratar permissões, recibos e recuperação conforme as dependências identificadas, evitando ciclos e estado global oculto.
3. Realizar uma extração por entrega revisável, preservando assinaturas públicas e comportamento sempre que possível. Separar mudanças funcionais das movimentações estruturais.
4. Manter domínio puro, transporte HTTP/WS e DTOs com responsabilidades explícitas. Documentar o mapa final de módulos e o caminho de uma mensagem/tarefa.

### Critérios de aceitação

- As responsabilidades extraídas têm entradas, saídas e proprietário do estado identificáveis, sem replicar a mesma regra em dois módulos.
- Os testes existentes de correlação, permissões, contexto, tarefas e reconciliação continuam aprovados; acrescentar cobertura apenas onde uma costura relevante ainda não estiver protegida.
- Tipos, suíte e build passam após as extrações, e as medições relevantes não mostram regressão sem justificativa.
- A revisão avalia preservação de comportamento e clareza das responsabilidades, não apenas redução da contagem de linhas.

---

## BL-08 — Recuperação de WebSocket, lacunas e retomada observável

- **Status:** Planejado (27/11/2026)
- **Prioridade:** Alta
- **Dependências:** BL-03 e referência de BL-04; execução recomendada após BL-07, podendo antecipar correções de falhas concretas.
- **Origem:** Política limitada de reconexão e ausência de limite explícito para eventos fora de ordem.

### Escopo proposto

1. Validar interrupção prolongada do Core, falha ao obter token WS, expiração de sessão, esgotamento de tentativas e reconexão manual/automática. Considerar os mecanismos existentes de conexão nas configurações e antes do envio de mensagens.
2. Ajustar retry/backoff e recuperação de erros conforme os cenários observados, respeitando desconexão explícita do usuário e evitando conexões simultâneas ou reenvio de ações já aceitas.
3. Definir política de tamanho/idade para `pendingOutOfOrder`. Ao atingir limites ou persistir uma lacuna, sinalizar o problema e iniciar recuperação compatível com as capacidades reais do Core; não descartar eventos silenciosamente.
4. Tornar estado e próximo passo de recuperação claros na UI, distinguindo canal WS, autenticação, disponibilidade do Core e trabalho ainda em execução no Core.
5. Validar retomada de tarefas, recibos e catch-up, inclusive com respostas parciais ou eventos recebidos durante a reconciliação.

### Critérios de aceitação

- Queda, esgotamento de tentativas e lacuna persistente têm estado visível e caminho de recuperação verificável.
- Reconexão manual continua disponível sem exigir reload nos casos recuperáveis; desconexão explícita não é revertida automaticamente sem ação que a justifique.
- Recuperação não duplica mensagens, despacho de tarefas, entregas ou pareceres; preserva eventos recebidos durante a consulta.
- Testes cobrem token indisponível, interrupção prolongada, limites do buffer, catch-up parcial e retomada. Evidências com Core real são registradas separadamente das fixtures.

---

## BL-09 — Compactação segura do histórico e índices de deduplicação

- **Status:** Planejado — condicionado a desenho e medições (27/11/2026)
- **Prioridade:** Condicionada ao impacto medido em BL-04/BL-05
- **Dependências:** BL-04, BL-05 e BL-08; considerar os módulos e contratos resultantes de BL-06/BL-07.
- **Origem:** Crescimento de `eventLog`, `seenEventIds`, mensagens e feeds sem política explícita de retenção.

### Escopo proposto

1. Inventariar os leitores do histórico e das posições no log, incluindo correlação de turnos/tentativas, recibos de contexto, reconstrução, reconciliação, backup/importação e auditoria.
2. Definir snapshots, fronteira de compactação, retenção e informações operacionais que devem sobreviver à remoção de eventos. Substituir dependências de posições instáveis por referências duráveis antes de compactar.
3. Projetar índice de deduplicação compatível com serialização, recarga e imutabilidade. Avaliar seu custo total: trocar array por um `Set` copiado integralmente a cada evento não elimina por si só o custo linear.
4. Definir tratamento de eventos antigos repetidos, eventos fora de ordem e snapshots atrasados, sem reaplicar ações já concluídas. Manter a trilha de auditoria exigida pelo produto e uma política explícita de arquivamento/consulta do histórico.
5. Planejar migração versionada e compatibilidade de backup. Implementar compactação somente após definir essas invariantes e confirmar benefício nas medições.

### Critérios de aceitação

- O desenho identifica quais dados permanecem necessários e demonstra por que podem ser removidos ou arquivados os demais.
- Testes cobrem compactação seguida de novos eventos, replay/duplicatas antigas, recarga, snapshot atrasado, eventos durante reconciliação, backup e importação.
- Correlação tarefa/tentativa/revisão, recibos, permissões e isolamento entre participantes permanecem corretos.
- As medições mostram redução de tempo, memória ou armazenamento sem perda de integridade. O benchmark de 2.000 eventos isoladamente não é critério suficiente de aprovação.
- Revisão independente do desenho e da implementação concluída antes de marcar a entrega como implementada.
