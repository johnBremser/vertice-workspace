# Backlog de Melhorias — Vértice Workspace

Registro priorizado de evoluções planejadas fora do escopo mínimo já entregue.

Índice e convenção de organização: [Backlog](README.md). Itens concluídos são retirados desta lista ativa após registro da entrega e das verificações em [CHANGELOG.md](../../CHANGELOG.md); seus identificadores não são reutilizados.

- **Itens concluídos e arquivados no [CHANGELOG.md](../../CHANGELOG.md):** `BL-01` (política de aprovação `acp_permission`), `BL-02` (arquivos alterados e diff na gaveta Trabalho) e `BL-03` (compatibilidade Node centralizada, diagnóstico antecipado e atualização de arquitetura/README).

---

## Plano de estabilização e manutenção (27/11/2026)

Os itens BL-04 a BL-09 compõem a fila ativa do plano de estabilização e manutenção. Foram definidos a partir da análise independente do workspace e da conferência dos pontos principais no código. Todos os itens abaixo estão **planejados**; sua inclusão no backlog não representa implementação nem validação concluída.

**Ordem recomendada:** BL-04 → BL-05 → BL-06 → BL-07 → BL-08 → BL-09. BL-08 pode ser antecipado se uma falha concreta de recuperação exigir correção. A compactação de histórico (BL-09) depende das medições e dos contratos de recuperação; não deve ser tratada como uma poda simples de arrays.

### Orientações para execução

- Conferir o estado atual do repositório e preservar alterações locais antes de modificar arquivos compartilhados.
- Trabalhar em entregas pequenas e registrar, em cada item, implementação, verificações executadas, evidências e limitações. Atualizar a documentação afetada junto com a mudança.
- Usar Node compatível com `engines.node`, registrar versões e estabelecer a referência inicial com `npm run lint`, `npm test` e `npm run build`. Executar testes relevantes durante cada entrega e as verificações completas ao concluir o conjunto; repetir quando houver alterações, falhas ou dúvidas concretas que justifiquem.
- Distinguir testes com fixtures, navegador e integração com Core/CLIs reais. Uma modalidade de validação não comprova automaticamente as demais.
- Submeter mudanças de persistência, correlação e recuperação à revisão independente antes de considerá-las concluídas.
- Preservar IDs, permissões, recibos de contexto, isolamento entre participantes e correlação tarefa/tentativa/revisão. Manter os identificadores de protocolo e persistência necessários à compatibilidade.

## BL-04 — Medição de desempenho do fluxo completo e do armazenamento

- **Status:** Planejado (27/11/2026)
- **Prioridade:** Alta
- **Dependências:** BL-03 (concluído no [CHANGELOG.md](../../CHANGELOG.md)).
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
- **Dependências:** BL-03 (concluído no [CHANGELOG.md](../../CHANGELOG.md)); aplicar em mudanças separadas para facilitar revisão.
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
- **Dependências:** BL-03 (concluído no [CHANGELOG.md](../../CHANGELOG.md)) e referência de BL-04; execução recomendada após BL-07, podendo antecipar correções de falhas concretas.
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
