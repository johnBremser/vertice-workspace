# Revisão do Aion Desk contra o plano v3

Data: 16/11/2026. Entrega analisada: `C:\llm\aion-desk`.

Referências: [plano v3](C:/llm/AionUi/docs/implementation_plan_v3.md), [briefing exportado](C:/llm/aion-desk/public/assets/aistudio/aionui-lite-aistudio-prompt_34b7c362.md), código local do AionUi e do AionCore.

## Parecer

A entrega está alinhada à direção do projeto e à arquitetura geral do v3, mas ainda não atende ao aceite funcional. Há implementação substancial: não é apenas uma tela estática. Entretanto, controles e regras importantes cedem ao roteiro predefinido quando o usuário interage fora do caminho feliz.

O tempo de oito minutos, isoladamente, não comprova qualidade nem falta dela. Os comportamentos reproduzidos abaixo fundamentam o parecer.

## O que está coerente

- Projeto independente em React e TypeScript estrito, com Tailwind v4, tokens semânticos e temas claro/escuro. O briefing permite essa independência; as bibliotecas Arco/UnoCSS do AionUi não são obrigatórias nesta entrega.
- Geral, abas por participante, gaveta de tarefas/contexto, configurações e exportação possuem implementações reais.
- Domínio, serviços e interface foram organizados separadamente. Há eventos tipados, deduplicação, buffer por conversa e funções distintas de reconciliação.
- Contadores de falha operacional e reprovação de qualidade estão separados; os testes existentes exercitam essa separação.
- Há persistência IndexedDB, aviso de modo de sessão, sanitização de execução após reload e carregamento separado de Markdown/configurações/exportação no build.
- A simulação é identificada. O adaptador do Core falha explicitamente com erro tipado em vez de declarar conexão inexistente.
- O encaminhamento Geral → coordenador e aba → participante corresponde conceitualmente ao Core local: `crates/aionui-team/src/session.rs:577` e `:591`, no commit `503a87199eb978790ca77675b39c84b241535bf3`. As rotas de mensagem de equipe e por participante também existem em `routes.rs:198` e `:199`.

A integração real com CLIs/Core não é requisito desta entrega pelo v3. Os DTOs do esqueleto continuam sendo candidatos: não constituem contratos de integração validados. Nenhum teste contra binário, CLI ou serviço externo foi realizado.

## Achados que impedem o aceite

### 1. P1 — A seleção de conversa e os recibos de leitura divergem do gateway

Fonte: [WorkspaceContext.tsx:274](C:/llm/aion-desk/src/features/workspace/WorkspaceContext.tsx:274), [WorkspaceContext.tsx:291](C:/llm/aion-desk/src/features/workspace/WorkspaceContext.tsx:291), [mockGateway.ts:103](C:/llm/aion-desk/src/services/mockGateway.ts:103).

`selectConversation` e `selectTab` alteram apenas o estado React. O gateway mantém outra cópia, e sua próxima notificação substitui integralmente o estado React. Além disso, o gateway ingere eventos sem informar a aba ativa ao reducer.

Reprodução no preview: criar uma segunda conversa; selecionar a original; enviar uma mensagem. A interface retorna indevidamente à segunda conversa. Abrir a aba Claude zera as novidades visualmente, mas enviar uma mensagem nessa própria aba faz as novidades antigas reaparecerem e contabiliza a resposta visível como não lida.

Correção: estabelecer uma fonte de verdade para a seleção e leitura, mantendo o estado de apresentação separado da projeção quando apropriado. Informar conversa/aba ativa ao cálculo de novidades. Cobrir o fluxo React → gateway → notificação em teste.

### 2. P1 — Aprovações, recusas e política configurada são ignoradas pelo roteiro

Fonte: [demoScenario.ts:619](C:/llm/aion-desk/src/services/demoScenario.ts:619), [demoScenario.ts:940](C:/llm/aion-desk/src/services/demoScenario.ts:940), [demoScenario.ts:965](C:/llm/aion-desk/src/services/demoScenario.ts:965).

Resultados reproduzidos por chamadas aos serviços reais da entrega:

- Com `approvalMode: manual`, avançar o cenário converte a promoção de `suggested` em `approved` sem aprovação específica do usuário. O autoplay também percorre esse caminho.
- Dispensar a promoção mantém a decisão `dismissed`, mas a tentativa seguinte usa `advanced` mesmo assim.
- Configurar o limite em cinco reprovações ainda gera sugestão após duas. O número configurado é usado no texto; não governa a condição do roteiro.
- Recusar a permissão de testes e avançar permite entrega e revisão da tentativa que estava bloqueada.

Correção: o cenário deve produzir eventos condicionados às regras e decisões vigentes. O avanço e o autoplay devem respeitar bloqueios, limiar e modo de aprovação. Aprovação manual precisa de ação específica e auditável; recusa precisa preservar seu efeito.

O teste existente que conclui automaticamente o cenário espera a promoção aprovada e, portanto, aceita esse desvio em vez de detectá-lo.

### 3. P1 — Avançar durante uma lacuna perde eventos e avança o roteiro

Fonte: [demoScenario.ts:457](C:/llm/aion-desk/src/services/demoScenario.ts:457), [mockGateway.ts:934](C:/llm/aion-desk/src/services/mockGateway.ts:934).

O gerador começa a sequência em `lastAppliedSeq`, mesmo com eventos futuros em buffer. `stepScenario` também avança o índice sem impedir execução durante `gap_detected`.

Reprodução: estado inicial → `triggerOutOfOrderGapScenario` → `stepScenario` → `reconcileConversation`. Resultado: a conversa declara `synced`, o índice avança para seis, a revisão v2 esperada não é publicada e o evento faltante original não é recuperado no histórico. Eventos do roteiro ocuparam sequências já reservadas pela simulação de lacuna.

Isso viola a regra do v3 de não executar transições sobre estado incompleto.

Correção: bloquear avanços dependentes de projeção enquanto há lacuna, garantir alocação única de sequência e avançar o cursor do cenário somente após aplicação bem-sucedida dos eventos.

### 4. P1 — Snapshot descarta eventos posteriores já aplicados

Fonte: [reducer.ts:913](C:/llm/aion-desk/src/domain/reducer.ts:913).

`reconcileWithSnapshot` preserva apenas `pendingOutOfOrder`. Eventos posteriores a `snapshotSeq` que já foram aplicados em `eventLog` desaparecem quando a projeção é substituída.

Reprodução: snapshot da sequência oito; receber/aplicar mensagem e resposta nas sequências nove/dez; reconciliar com o snapshot oito. Resultado: cursor regride de dez para oito e a mensagem desaparece.

O teste existente cobre somente eventos futuros retidos em buffer. Ele não cobre eventos que se tornaram contíguos durante a consulta.

Correção: mesclar os eventos locais posteriores ao limite do snapshot, incluindo os já aplicados e os pendentes, com deduplicação e reaplicação em ordem sobre o snapshot.

### 5. P2 — Revisões de contexto do roteiro colidem com revisões criadas pelo usuário

Fonte: [demoScenario.ts:467](C:/llm/aion-desk/src/services/demoScenario.ts:467), [demoScenario.ts:785](C:/llm/aion-desk/src/services/demoScenario.ts:785).

O roteiro fixa `ctx_rev_2` e `versionNumber: 2`; tentativas posteriores também fixam essa revisão. Publicar manualmente uma v2 antes do primeiro avanço gera duas revisões chamadas v2, com IDs diferentes. A continuação se prende à revisão fixa do roteiro.

Correção: usar um mecanismo único de publicação, calcular versões a partir do estado efetivo e vincular cada tentativa à revisão efetivamente entregue/aplicada. Cobrir edição de contexto antes e durante o roteiro.

### 6. P2 — A instalação documentada falha em ambiente limpo com npm

Fonte: [package.json:25](C:/llm/aion-desk/package.json:25) e [package.json:33](C:/llm/aion-desk/package.json:33).

`npm install --ignore-scripts --no-audit --no-fund --package-lock=false` falhou com `ERESOLVE`: Vite resolvido em `8.3.8` pede esbuild opcional `^0.27.0 || ^0.28.0`, enquanto o projeto fixa a família `^0.25.0`.

O Node disponível na máquina era `20.18.1`, abaixo do requisito dos pacotes resolvidos. Isso é uma limitação local adicional, distinta do conflito de dependências. O projeto não declara `engines` nem documenta a versão necessária de Node. Há `bun.lock`, mas o README orienta instalação com npm.

Correção: alinhar versões, declarar o runtime e escolher/documentar o gerenciador e lockfile que serão usados para reproduzir a instalação.

### 7. P2 — Alguns links “Ver execução” apontam para eventos que não são renderizados

Fonte: [reducer.ts:357](C:/llm/aion-desk/src/domain/reducer.ts:357), [reducer.ts:403](C:/llm/aion-desk/src/domain/reducer.ts:403), [MessageStream.tsx:123](C:/llm/aion-desk/src/features/workspace/MessageStream.tsx:123), [MessageStream.tsx:437](C:/llm/aion-desk/src/features/workspace/MessageStream.tsx:437).

Achado confirmado por leitura cruzada do produtor e consumidor: a Geral aponta, por exemplo, para o evento de início de tentativa `evt_007`, mas a aba do agente renderiza somente mensagens — nesse caso, a mensagem é `evt_008`. O seletor procura o ID de evento no conjunto de mensagens e não encontra o início/entrega da tentativa. A aba pode abrir sem localizar e destacar a origem exigida pelo plano.

Correção: renderizar os eventos de execução relevantes ou definir uma referência explícita para um registro renderizado que represente exatamente aquela origem. Evitar associações implícitas ao evento seguinte.

## Observação adicional de persistência

[storage.ts:257](C:/llm/aion-desk/src/services/storage.ts:257) não serializa chamadas de `flushSave` e sempre anuncia `saved` ao terminar uma gravação, mesmo se outra versão estiver pendente. Com um driver de teste que atrasa a gravação antiga, reproduzi a conclusão fora de ordem: a versão antiga substitui a nova e o status termina `saved`.

Essa reprodução exercita a abstração `StorageDriver`; não foi uma medição de corrida do IndexedDB real. Convém serializar gravações e associar o status à versão mais recente antes de afirmar durabilidade sob gravações concorrentes.

## Validação executada e seus limites

- `npm run lint`: passou, executando `tsc --noEmit`.
- Suíte existente: dois arquivos, 11 testes passaram, usando Node `24.22.3` obtido temporariamente via npm exec.
- Build: passou com o mesmo Node 24, gerando chunks separados para Markdown, configurações e exportação.
- Para permitir esses testes foi necessário instalar dependências com `--legacy-peer-deps` e adicionar o binding Windows do rolldown com `--no-save`. Esses contornos não corrigem o manifesto entregue.
- Preview em Chrome: falhas de seleção e novidades reproduzidas pela interface.
- [Script de reprodução adicional](./aion-desk-review.mts): oito casos observacionais, executados sobre o código existente, cobrindo promoção manual, promoção dispensada, limiar configurado, permissão negada, lacuna, contexto duplicado, snapshot e escrita concorrente.
- Não foram executados testes completos de acessibilidade, responsividade, evicção real de storage, carga de 2.000 eventos no navegador ou integração real com o Core. Nenhuma conclusão positiva sobre esses caminhos é inferida dos 11 testes.

Nenhum arquivo de código, manifesto ou lockfile da entrega foi alterado. A revisão criou `node_modules`, `dist`, dados de teste no armazenamento da origem local do preview e os artefatos desta pasta. A pasta da entrega não possui `.git`, portanto a revisão incidiu sobre o conteúdo exportado, sem um diff de commits do agente.

## Ordem recomendada para correção

1. Fonte de verdade da interface/gateway e seleção/leitura.
2. Regras de autorização, escalonamento e avanço do cenário.
3. Lacunas e reconciliação de snapshots sem perda.
4. Versionamento dinâmico de contexto.
5. Instalação reproduzível e rastreabilidade dos links.

Preservar a arquitetura independente e corrigir esses fluxos incrementalmente. A conexão real ao AionCore permanece a etapa posterior prevista no v3.
