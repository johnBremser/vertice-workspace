# Prompt para Google AI Studio — interface enxuta de colaboração entre agentes

Copie o conteúdo entre INÍCIO DO PROMPT e FIM DO PROMPT para o Build do Google AI Studio. Este é um briefing para criar um projeto independente. Não é uma instrução para modificar os clones atuais.

---

## INÍCIO DO PROMPT

Quero que você desenvolva uma aplicação web em React e TypeScript para colaboração entre agentes de programação. O nome provisório é **Aion Desk**; deixe o nome centralizado para eu trocar depois. A primeira entrega deve funcionar no preview do Google AI Studio e permitir exportar o código para continuar o desenvolvimento localmente.

Leia todo este briefing antes de implementar. Quero uma aplicação interativa, com bom acabamento e arquitetura pequena. Use os projetos de referência para aproveitar boas soluções e entender o domínio. O produto precisa ter identidade própria e foco na minha experiência de trabalho.

**Prioridade desta entrega:** uma interface funcional com simulação determinística, persistência local e uma fronteira de integração bem definida para o AionCore. A conexão real com executáveis e contas de IA será uma etapa local posterior. Não apresente dados de demonstração como execução real.

### 1. O problema que quero resolver

Eu uso agentes de programação de fornecedores diferentes. Gostei de uma experiência em que um agente atuava como coordenador/auditor e delegava trabalho a outro agente, mas faltavam visibilidade da execução, contexto comum e centralização do histórico.

Experimentei o AionUi. Ele já faz muita coisa interessante, mas tem um escopo grande e a experiência inicial pareceu pesada. Na primeira abertura em desenvolvimento a janela ficou branca por bastante tempo, embora depois tenha carregado. Ainda não fiz uma comparação com o build de produção nem validei todas as integrações de agentes.

O modo com várias conversas lado a lado é interessante, mas para meu uso eu prefiro:

- Uma conversa principal, chamada **Geral**, com o coordenador e os acontecimentos relevantes.
- Uma aba para cada agente, com a execução detalhada daquele participante.
- Liberdade para escolher quem coordena e quem executa ou revisa.
- Entender o que está sendo feito, por quem, por qual motivo e com qual resultado.
- Orientações compartilhadas, com registro de entrega e aplicação por participante.
- Histórico persistente por projeto e por conversa.
- Recuperação de desconexão e falhas sem perder o trabalho já registrado.
- Controle de modelos, tentativas e escalonamento de qualidade.
- Uma interface tranquila de usar durante horas, com poucos elementos competindo por atenção.

Não trate esse produto como um chatbot genérico conectado ao Gemini. O centro do produto é a coordenação observável de agentes, sessões, tarefas e decisões.

### 2. Projetos de referência e contexto técnico real

Existem dois projetos públicos distintos:

**AionUi — interface e aplicação desktop**

- Repositório: https://github.com/iOfficeAI/AionUi
- Snapshot analisado: `e108b6b56b1a6eb99a00904878d0582f657b2908`.
- Versão do package.json nesse snapshot: `2.2.2`.
- Clone local do usuário: `C:\llm\AionUi`.
- Tecnologias observadas: React, TypeScript, Electron, Vite, Arco Design e UnoCSS.
- Arquitetura: https://github.com/iOfficeAI/AionUi/blob/e108b6b56b1a6eb99a00904878d0582f657b2908/docs/architecture/overview.md
- Dependências: https://github.com/iOfficeAI/AionUi/blob/e108b6b56b1a6eb99a00904878d0582f657b2908/package.json

**AionCore — núcleo local**

- Repositório: https://github.com/iOfficeAI/AionCore
- Snapshot analisado: `503a87199eb978790ca77675b39c84b241535bf3`.
- Clone local do usuário: `C:\llm\AionCore`.
- Tecnologias observadas: Rust, Tokio, Axum, HTTP, WebSocket e SQLite.
- O frontend fixa a release `v0.2.2` do Core.
- Release: https://github.com/iOfficeAI/AionCore/releases/tag/v0.2.2
- Arquitetura: https://github.com/iOfficeAI/AionCore/blob/503a87199eb978790ca77675b39c84b241535bf3/ARCHITECTURE.md
- Workspace: https://github.com/iOfficeAI/AionCore/blob/503a87199eb978790ca77675b39c84b241535bf3/Cargo.toml

O usuário já iniciou o AionUi pelo fonte usando o Core oficial pré-compilado v0.2.2. A tela inicial carregou e o Core respondeu a `/health`. Isso valida a inicialização; não prova que todas as integrações de CLI, contas ou fluxos de equipe funcionam.

O commit do clone do Core e o binário de uma release não devem ser tratados como código necessariamente idêntico. Contratos devem ser conferidos contra a versão que efetivamente será executada.

Os caminhos `C:\...` são contexto para o desenvolvimento local posterior. Não afirme que leu esses diretórios dentro do ambiente do AI Studio. Se conseguir consultar GitHub, use as referências públicas. Caso não consiga, use as informações explícitas deste briefing e informe quais arquivos não foram consultados.

Não importe os dois monorepos inteiros para criar este protótipo. Crie um projeto independente e pequeno. Não sobrescreva os clones, suas configurações, seus dados ou seu histórico.

### 3. O que aproveitar, adaptar e criar

#### Aproveitar como base de domínio e futura integração

- Separação entre frontend e Core local.
- Catálogo e diagnóstico de agentes.
- Ciclo de vida de processos e sessões.
- Histórico de conversas e mensagens.
- Eventos em tempo real e reconexão.
- Equipes, escolha de líder, participantes, mailbox e tarefas.
- Persistência e recuperação já existentes no núcleo.
- Distinção entre envio ao coordenador e envio a um participante específico.

Esses recursos foram identificados no código. A integração real com cada fornecedor precisa ser testada antes de ser declarada operacional.

#### Copiar seletivamente ou adaptar na interface

- Ideia das abas por agente e de seus indicadores de atividade.
- Identidade de cada participante, com papel, modelo e estado.
- Seleção de uma única conversa visível por vez.
- Composição de mensagens, Markdown e blocos de código.
- Atualização incremental do histórico por eventos.
- Paginação e preservação da posição de leitura.
- Exibição de tarefas, bloqueios e solicitações de permissão.

Prefira reimplementar componentes visuais pequenos com contratos claros quando o componente original trouxer muitas dependências. Se copiar código, preserve licenças, avisos e atribuições aplicáveis. Não copie marcas ou a identidade visual como se o novo aplicativo fosse um produto oficial do AionUi.

#### Diferenciais que precisamos projetar

1. Geral como conversa principal e projeção dos eventos relevantes.
2. Contexto comum versionado e rastreável por participante.
3. Relação explícita entre pedido, tarefa, tentativa, entrega, revisão e decisão.
4. Política configurável de modelos e escalonamento por qualidade.
5. Recuperação com estados honestos e ações compreensíveis.
6. Interface com escopo menor e carregamento previsível.
7. Exportação útil do histórico em Markdown e JSON.

Não diga que esses diferenciais estão prontos no Core. Alguns aproveitam recursos existentes; outros exigirão adaptação futura de backend.

### 4. Arquivos que ajudam a entender a referência

Use os caminhos abaixo como mapa de leitura. Consulte os snapshots fixados, e não assuma que o branch principal continua igual.

Base dos links do AionUi:

`https://github.com/iOfficeAI/AionUi/blob/e108b6b56b1a6eb99a00904878d0582f657b2908/`

- `packages/desktop/src/renderer/pages/team/TeamPage.tsx`: composição das visões de equipe.
- `packages/desktop/src/renderer/pages/team/components/TeamTabs.tsx`: abas de participantes, estados e contadores.
- `packages/desktop/src/renderer/pages/team/components/TeamViewToggle.tsx`: alternância entre parallel, single e board.
- `packages/desktop/src/renderer/pages/team/hooks/useTeamViewMode.ts`: preferência de visualização; parallel é o padrão observado.
- `packages/desktop/src/renderer/pages/team/components/TeamChatView.tsx`: conversa individual e envio ao líder ou ao participante.
- `packages/desktop/src/renderer/pages/team/components/TeamCreateModal.tsx`: criação da equipe e escolha do líder.
- `packages/desktop/src/renderer/pages/team/activity/TeamActivityView.tsx`: quadro agregado de mensagens e tarefas.
- `packages/desktop/src/renderer/pages/team/activity/useTeamActivityFeed.ts`: carregamento do feed.
- `packages/desktop/src/renderer/pages/settings/AgentSettings/LocalAgents.tsx`: lista de agentes locais.
- `packages/desktop/src/renderer/pages/settings/AgentSettings/AgentRepairPanel.tsx`: diagnóstico e reparo.
- `packages/desktop/src/common/adapter/httpBridge.ts`: acesso aos dados do Core.
- `packages/web-host/src/backend-launcher.ts`: inicialização e supervisão do Core.
- `packages/web-cli/src/index.ts`: caminho existente de execução web sem Electron.

Base dos links do AionCore:

`https://github.com/iOfficeAI/AionCore/blob/503a87199eb978790ca77675b39c84b241535bf3/`

- `crates/aionui-team/src/session.rs`: envio ao líder, envio direcionado e entrega de mensagens.
- `crates/aionui-team/src/mailbox.rs`: mailbox persistida.
- `crates/aionui-team/src/prompts/mod.rs`: composição de contexto para despertar participantes.
- `crates/aionui-team/src/service.rs`: operações de equipes.
- `crates/aionui-team/src/routes.rs`: contratos HTTP das equipes.
- `crates/aionui-team/src/event_loop.rs`: processamento dos eventos.
- `crates/aionui-team/src/work_coordinator/coordinator.rs`: coordenação de trabalho.
- `crates/aionui-team/src/scheduler/crash_recovery.rs`: recuperação de falhas.
- `crates/aionui-team-prompts/src/role_prompt.rs`: instruções de coordenação e execução.
- `crates/aionui-ai-agent/src/lib.rs`: mapa do domínio de agentes.
- `crates/aionui-api-types/src/team_tools.rs`: contratos das ferramentas de equipe.

Constatações importantes para não construir sobre uma premissa errada:

- O AionUi já possui modo single e abas; o diferencial aqui é fazer da conversa Geral o centro da experiência e simplificar o conjunto.
- O envio geral observado no Core vai ao líder; o envio individual vai ao participante indicado. Isso não equivale a entregar automaticamente todas as orientações a todos.
- O quadro agregado observado é uma visão de mensagens e tarefas, somente leitura. Não é a conversa Geral resumida que estou pedindo.
- Repetir uma entrega que falhou é diferente de reprovar a qualidade de uma tarefa e promover o modelo.
- O painel de agentes não comprova uma central universal de contas e assinaturas.
- O comportamento de um CLI só pode ser afirmado a partir de documentação, código oficial, esquema real ou teste contra aquele CLI. Não invente protocolos, comandos de autenticação ou parâmetros de modelos.

### 5. Escopo exato da primeira entrega no AI Studio

Implemente uma aplicação web utilizável com:

- Projeto e conversa demonstrativos já preenchidos.
- Aba Geral funcional.
- Abas individuais dos agentes.
- Lista compacta de tarefas vinculadas à conversa.
- Painel de contexto compartilhado.
- Configurações essenciais de agentes, modelos e política de escalonamento.
- Simulação controlada de uma execução completa.
- Persistência local dos dados de demonstração e preferências.
- Exportação de histórico.
- Estados de carregamento, vazio, erro, desconexão e recuperação.
- Código preparado para trocar o adapter simulado por uma integração real futura.

Não adicione chamadas à API Gemini ao aplicativo só porque ele está sendo criado no AI Studio. A geração do código pelo AI Studio é separada do funcionamento do aplicativo gerado. Esta primeira versão deve funcionar sem chave de API e sem consumir inferência para simular agentes.

Não provisione Firebase, login Google, Cloud Run, banco externo, serviços de telemetria ou armazenamento em nuvem. Não faça deploy nem publique o projeto. O preview e a exportação do código são suficientes.

### 6. Stack e organização

Use:

- React com componentes funcionais.
- TypeScript em modo estrito, sem `any` nos contratos de domínio.
- Vite para desenvolvimento e build.
- CSS Modules e variáveis CSS para tema, espaçamento e cores.
- Uma única biblioteca de ícones, com importação seletiva.
- Estado centralizado pequeno; escolha Context + reducer ou uma biblioteca leve se houver benefício concreto. Evite misturar várias soluções de estado.
- IndexedDB para histórico/eventos, se viável no preview; uma camada de storage deve permitir fallback explícito para memória quando o ambiente bloquear persistência.
- Preferências pequenas e não sensíveis podem usar localStorage.
- Vitest e testes de comportamento nos caminhos críticos, se o ambiente permitir executá-los.

Comece com poucas dependências. Adicione bibliotecas por uma necessidade identificável. Carregue renderização rica de Markdown/código e telas secundárias sob demanda quando necessário.

A aplicação nova é independente; não precisa herdar todas as dependências visuais do AionUi. Se decidir modificar arquivos do AionUi original em outra etapa, siga o AGENTS.md daquele repositório, incluindo Arco, Icon Park, i18n e separação de processos. Esta entrega não modifica o original.

Sugestão de divisão por responsabilidade, que você pode ajustar mantendo a simplicidade:

- `app`: inicialização, navegação e composição.
- `features/projects`: projetos e conversas.
- `features/workspace`: layout, abas e conversa principal.
- `features/agents`: catálogo, conexão e configuração.
- `features/tasks`: tarefas, tentativas e revisão.
- `features/context`: revisões e recibos de contexto.
- `domain`: tipos, regras e redução de eventos.
- `services`: adapter, storage, exportação e cenários de demonstração.
- `components`: componentes compartilhados e acessíveis.

Evite um App.tsx gigante, arquivos que misturam interface com transporte e abstrações genéricas sem consumidor real. Evite diretórios com um único arquivo e mantenha até dez filhos diretos nos diretórios criados quando possível.

Use português brasileiro na interface, inglês em identificadores e comentários técnicos. Centralize os textos visíveis em um dicionário pt-BR para permitir internacionalização futura. Não instale dezenas de idiomas nesta primeira versão.

### 7. Layout e direção visual

Crie uma ferramenta de trabalho com aparência sóbria e acabamento consistente.

#### Estrutura principal

- Barra lateral esquerda, recolhível, com projetos e conversas.
- Cabeçalho com nome do projeto/conversa, estado da execução, coordenador atual e ações essenciais.
- Faixa de abas logo abaixo, com Geral fixa em primeiro lugar.
- Área principal com uma única conversa ou painel ativo.
- Composer fixo na parte inferior da conversa.
- Painéis secundários de tarefas e contexto em gavetas ou uma lateral recolhível, abertos sob demanda.
- Configurações em uma superfície própria e simples, sem disputar espaço com a conversa.

Não monte conversas de todos os agentes em colunas por padrão. Uma comparação lado a lado pode ser uma evolução, mas não é necessária nesta entrega.

#### Aparência

- Tema escuro bem trabalhado e alternativa clara, seguindo a preferência do sistema na primeira abertura.
- Neutros, contraste legível e uma cor de destaque discreta.
- Tipografia de sistema para evitar download de fontes.
- Texto monoespaçado apenas onde ajuda: comandos, código, IDs e arquivos.
- Espaçamento compacto, sem apertar alvos de clique ou texto.
- Estados identificáveis por texto e ícone, além da cor.
- Poucas animações, curtas, respeitando prefers-reduced-motion.
- Nada de grandes gradientes, brilho, cartões gigantes ou gráficos decorativos.
- Sem imagens geradas, vídeos ou recursos pesados para ornamentação.
- Estados vazios com orientação útil e uma ação clara.

Priorize desktop a partir de aproximadamente 1280 px de largura. Em telas menores, recolha a lateral e mantenha Geral e o composer utilizáveis. As abas podem rolar horizontalmente sem provocar rolagem horizontal da página inteira.

### 8. A conversa Geral

A Geral é a minha superfície principal de trabalho. Ela deve reunir a conversa com o coordenador e os acontecimentos relevantes da equipe de forma rastreável.

Ela mostra:

- Pedidos e orientações do usuário.
- Entendimento e plano do coordenador.
- Delegações, com responsável e critérios de aceitação.
- Mudanças importantes de estado.
- Entregas resumidas dos executores.
- Aprovação, reprovação e pedidos de correção.
- Bloqueios e solicitações de intervenção.
- Mudanças de contexto e seus recibos.
- Decisões de escalonamento de modelo.
- Conclusão e evidências associadas.

Saídas extensas de ferramentas, logs brutos e trechos repetidos ficam nas abas individuais. Na Geral, use itens compactos que apontem para os eventos de origem.

Cada item relevante deve mostrar quem fez, quando, o que mudou e um link como “Ver execução” ou “Abrir tarefa”. Ao seguir o link, abra a aba correta e destaque o evento correspondente; se ele ainda não estiver carregado, resolva a navegação com feedback adequado.

Não use geração de texto para inventar resumos na demonstração. Construa a projeção da Geral a partir de eventos tipados e textos de cenário, preservando `sourceEventIds`. Uma síntese por LLM pode ser acrescentada depois, mas a rastreabilidade não deve depender dela.

Evite duplicar uma mesma mensagem ou entrega quando ela aparecer como conversa do coordenador e como evento de tarefa. Um mesmo acontecimento pode ter representações em mais de uma tela, mas deve ter identidade e origem únicas.

O composer da Geral envia ao coordenador no modelo de domínio. A opção de transformar uma orientação em contexto compartilhado deve ser explícita. Não marque todos os agentes como atualizados apenas porque o usuário enviou uma mensagem.

### 9. Abas individuais dos agentes

Exemplo inicial de abas:

- Geral.
- Codex — Coordenador.
- Claude — Executor.
- Antigravity — Revisor.

Esses nomes servem para a demonstração. Não implicam que um binário esteja instalado ou conectado, nem que o fornecedor disponibilize determinado modelo ou função.

Cada aba mostra:

- Nome e papel.
- Estado textual: ocioso, preparando, executando, aguardando revisão, aguardando permissão, bloqueado, desconectado, falhou ou concluído.
- Indicador de novidades desde a última leitura.
- Tarefa atual.
- Modelo selecionado, quando conhecido.
- Conversa detalhada, eventos de ferramenta e artefatos.
- Controles pertinentes ao estado: enviar, solicitar interrupção, retomar ou repetir conexão.

O adapter deve informar quais ações são suportadas. Não exiba troca de modelo em andamento ou interrupção como operação disponível se a capacidade não existir.

Trocar de aba não cancela uma tarefa, não inicia outro agente e não dispara novo envio. Preserve rascunho, posição de leitura e seleção por conversa. Atualize os contadores das abas inativas sem montar suas listas completas de mensagens.

Uma mensagem direta a um agente tem destinatário visível. Orientações que devam valer para todos precisam passar pelo mecanismo de contexto compartilhado, com indicação clara de escopo.

### 10. Projetos, conversas e participantes

- Permita criar, renomear, selecionar e arquivar projetos e conversas.
- Arquivamento deve ser reversível; evite exclusão destrutiva como fluxo padrão.
- O projeto pode guardar um caminho de workspace como informação textual.
- No preview, preencher um caminho não dá acesso aos arquivos locais. Não simule leitura de disco como se ela tivesse ocorrido.
- Uma conversa possui coordenador, participantes, mensagens, eventos, tarefas e revisão de contexto.
- Mostre o papel de cada participante e permita configurá-lo antes da execução.
- Para mudanças de coordenador durante uma execução, apresente uma transição explícita e registre a decisão; não invente transferência automática de sessão entre fornecedores.
- Adicionar uma aba não equivale a iniciar um processo ou a autenticar um fornecedor.

### 11. Contexto comum versionado

Quero resolver um problema concreto: enviar uma restrição importante e não saber se o executor recebeu essa restrição.

Implemente um painel com:

- Objetivo do projeto/conversa.
- Instruções permanentes.
- Restrições.
- Critérios de aceitação.
- Decisões confirmadas.
- Revisão atual e histórico de revisões.

Ao salvar uma mudança, crie uma revisão imutável, com ID, número, autor, horário e texto alterado ou snapshot correspondente.

Para cada participante, mostre recibos distintos:

1. Pendente de envio.
2. Enviada.
3. Recebida, se o mecanismo confirmar recebimento.
4. Aplicada ao contexto da execução, somente se houver confirmação suficiente.
5. Falhou ou exige intervenção.

O nome exato desses estados pode ser ajustado, mas não trate “enviada” como prova de que o modelo leu ou seguiu a instrução. Se o backend só comprovar entrega ao processo, descreva esse limite.

Durante uma tarefa, uma atualização deve informar como será tratada: aplicação no próximo turno, envio suportado durante a execução ou interrupção solicitada. Na demonstração, represente essas alternativas com capacidades configuradas e eventos explícitos.

Vincule a tentativa de tarefa à revisão de contexto que ela recebeu. Se houver uma revisão mais nova pendente, mostre essa diferença.

Essa funcionalidade é uma proposta do novo produto. Não presuma que existe pronta no contrato do AionCore v0.2.2.

### 12. Tarefas, revisão e critérios de qualidade

As tarefas ficam vinculadas ao pedido original. Cada uma possui:

- Título e descrição objetiva.
- Responsável e revisor, quando aplicável.
- Dependências.
- Critérios de aceitação.
- Estado.
- Tentativas e respectivas entregas.
- Evidências e referências aos eventos de execução.
- Revisão do contexto utilizada.
- Decisão da revisão e justificativa.

Um fluxo suficiente para a demonstração é:

`planejada → na fila → em execução → aguardando revisão → concluída`

Uma reprovação cria “correção necessária” e uma nova tentativa; bloqueio, falha e cancelamento possuem estados próprios. Preserve a entrega reprovada e seus motivos.

Uma mensagem do executor dizendo “terminei” significa entrega para revisão, quando houver critério/revisor obrigatório. Não marque automaticamente a tarefa como aceita.

Separar os contadores:

- Falhas operacionais: processo, rede, entrega ou indisponibilidade.
- Reprovações de qualidade: entrega não atende aos critérios.

Uma falha de rede não deve consumir uma tentativa de qualidade. Uma nova entrega não apaga a revisão anterior. O comando de repetir uma operação deve ser idempotente ou possuir chave que impeça duplicação acidental.

Ao mostrar dependências, dispare a tarefa dependente quando o pré-requisito estiver concluído conforme a regra definida. Não mantenha um agente de demonstração gerando mensagens vazias de “aguardando” a cada segundo.

### 13. Modelos e escalonamento

Inclua uma configuração simples para:

- Perfil padrão para tarefas básicas.
- Perfil para revisão.
- Perfil avançado para escalonamento.
- Quantidade de reprovações de qualidade antes de sugerir promoção.
- Política de aprovação da promoção.

Exemplo de demonstração: após duas reprovações de qualidade da mesma tarefa, sugerir o perfil avançado. A mudança deve mostrar motivo, tentativa, responsável e efeito esperado.

Use rótulos genéricos como “Rápido”, “Revisão” e “Avançado” nos dados simulados, identificados como perfis de demonstração. Não invente IDs reais de modelos de Codex, Claude ou Antigravity.

Em uma integração real, a lista virá do adapter/catálogo validado. Troca no meio da sessão só deve ser habilitada quando suportada. Quando for necessário abrir outra sessão e entregar um resumo/contexto, isso precisa aparecer como operação distinta e auditável.

Na demonstração, a política funciona com eventos simulados e nunca faz chamadas pagas. Não exiba custo, economia, tokens ou saldo como se fossem medições reais. Dados financeiros desconhecidos devem permanecer desconhecidos.

### 14. Conexões, contas e capacidades

Crie uma área compacta de agentes disponíveis, sem prometer uma central universal de login.

Mostre separadamente:

- Agente configurado.
- Executável encontrado, quando isso puder ser verificado localmente.
- Autenticação conhecida ou desconhecida.
- Conexão testada.
- Sessão ativa.
- Capacidades disponíveis.

No modo de demonstração, identifique todos esses estados como simulados. Clicar em “Testar conexão” deve produzir um resultado de simulação reconhecível.

O login real de um CLI pode depender do próprio terminal e das configurações oficiais do fornecedor. Não crie campos de usuário/senha para imitar esse login. Não armazene chaves ou tokens em localStorage, IndexedDB, fixtures, URLs, logs ou exportações.

APIs de modelos são uma possibilidade futura e precisam de um motor de agente com ferramentas e permissões. Fazer uma chamada isolada de chat a uma API não equivale a implementar um agente de programação.

### 15. Fronteira entre frontend, simulação e Core

Crie uma interface de serviço de domínio, por exemplo `AgentWorkspaceGateway`, consumida pelos componentes e hooks. Os nomes abaixo são sugestões internas do novo produto, não endpoints existentes do Core:

- carregar/criar projetos e conversas;
- listar/configurar participantes;
- enviar mensagem ao coordenador;
- enviar mensagem direcionada;
- consultar histórico paginado;
- assinar eventos e cancelar a assinatura;
- consultar estado de execução;
- solicitar pausa/interrupção e retomada, conforme capacidades;
- responder a uma permissão;
- consultar tarefas e registrar revisão;
- publicar revisão de contexto e consultar recibos;
- exportar histórico.

Implemente `MockWorkspaceGateway` com comportamento real de aplicação: validação, estados, erros, persistência e eventos reproduzíveis.

Para o Core real, entregue um mapa de integração documentado e, se útil, uma implementação mínima não conectada que falhe de modo explícito para operações ainda não mapeadas. Não deixe botões de “Conectado” ligados a métodos vazios. Um método não implementado deve retornar uma indisponibilidade tipada e compreensível.

Separe:

1. DTOs do transporte externo.
2. Conversão/normalização feita pelo adapter.
3. Tipos e regras do domínio da interface.
4. Componentes React.

Não espalhe URLs, chamadas fetch, nomes de eventos externos e interpretação de respostas pelos componentes.

Durante a futura integração, verificar as rotas, payloads, autenticação e eventos da release executada. Não invente `/api/context`, `/api/orchestrator` ou outros endpoints só porque seriam convenientes. Recursos novos devem ser documentados como extensões propostas.

O preview na nuvem não é o computador Windows do usuário. Um servidor Node do AI Studio não acessa o `127.0.0.1` do usuário; no navegador, o acesso a serviços locais também depende de origem, permissões, CORS e políticas. Não use túnel, exposição pública ou desativação de proteções para contornar isso. A conexão local será validada depois da exportação.

O objetivo futuro é frontend web local + Core, com possível shell Tauri. Não implemente Electron ou Tauri nesta entrega. Não crie uma segunda implementação Rust do Core.

### 16. Modelo mínimo de dados e eventos

Defina tipos pequenos e consistentes para:

- Project.
- WorkspaceConversation.
- AgentProfile e AgentCapabilities.
- Participant e CoordinatorAssignment.
- Message e MessageDelivery.
- Task, TaskAttempt e TaskReview.
- SharedContextRevision e ContextReceipt.
- ExecutionEvent e GeneralFeedItem.
- ModelPolicy e EscalationDecision.
- PermissionRequest e PermissionDecision.
- ConnectionState.

Cada evento deve possuir identidade estável, conversa, origem, horário, tipo e referências pertinentes a participante, tarefa e tentativa. Inclua ordenação/cursor e correlação quando necessário. Use uniões discriminadas para diferenciar os payloads.

A projeção da Geral e os estados de tarefa devem ser derivados de eventos e snapshots com regras explícitas. Não mantenha cópias independentes do mesmo estado em cada componente.

Trate duplicação de eventos sem duplicar mensagens. Se houver lacuna ou evento fora de ordem que impeça uma decisão confiável, sinalize a necessidade de reconciliar o snapshot. Não descarte silenciosamente acontecimentos relevantes.

Esses são contratos internos propostos para este protótipo. Não os apresente como a especificação existente de WebSocket do AionCore.

### 17. Histórico e persistência

- Persistir projetos, conversas, mensagens, eventos, tarefas, contexto e preferências não sensíveis.
- Após recarregar o preview, preservar os dados já registrados.
- Versionar o esquema de armazenamento.
- Se o storage estiver indisponível ou sem espaço, mostrar um aviso útil e oferecer exportação; não perder dados silenciosamente.
- Não criar temporizadores ou execuções duplicadas após recarregar.
- Uma execução simulada que estava em andamento pode voltar como “demonstração pausada” e oferecer retomada explícita.
- Exportação Markdown legível: objetivo, participantes, contexto/revisões, Geral, tarefas, decisões e conversas detalhadas.
- Exportação JSON versionada: IDs, relações, eventos e dados suficientes para preservar rastreabilidade.
- A exportação ocorre por ação do usuário e não envia dados para serviços externos.

No produto integrado, o Core continuará sendo candidato a fonte de verdade dos dados persistentes. O armazenamento do protótipo não deve impor uma segunda base concorrente em produção.

### 18. Permissões e ações reais

Inclua uma solicitação de permissão simulada no cenário: por exemplo, uma ferramenta que pretende executar um comando de teste em um workspace demonstrativo.

Mostre agente, tarefa, ação solicitada, escopo e opções pertinentes. A resposta gera um evento e altera o estado da simulação.

Não execute o comando real. Não trate uma preferência de UI como autorização permanente para todo tipo de ação. Em integração futura, permissões precisam ter escopo, prazo e vínculo com a solicitação efetiva.

A interface deve diferenciar:

- Pausar o fluxo de novas tarefas.
- Solicitar interrupção de uma execução ativa.
- Encerrar uma sessão/processo.

Mostre apenas o que o adapter suporta. Uma falha ao enviar a interrupção não pode aparecer como execução interrompida com sucesso.

### 19. Cenário demonstrativo completo

Crie dados fictícios, sem nomes de empresas, arquivos ou informações privadas do usuário.

Projeto: **Portal de demonstração**.

Pedido inicial: **Adicionar uma busca por nome em uma listagem, preservando a estrutura existente.**

Participantes: coordenador, executor e revisor. Os perfis podem usar os nomes de ferramentas conhecidos, mas todos devem ser marcados como demonstração.

O cenário deve permitir acompanhar:

1. Usuário envia o pedido na Geral.
2. Coordenador registra entendimento e um plano curto.
3. São criadas tarefas com critérios de aceitação.
4. Contexto v1 é entregue com recibos independentes por participante.
5. Executor começa uma tentativa e publica eventos detalhados em sua aba.
6. A Geral recebe apenas progresso relevante e links para a execução.
7. Usuário acrescenta uma restrição: “Preservar os testes existentes; acrescentar cobertura para a busca”.
8. É criada a revisão v2, com estados de entrega/aplicação visíveis.
9. Executor entrega um resultado simulado; o revisor identifica um critério não atendido.
10. Uma reprovação registra motivo e cria a tentativa seguinte.
11. Uma segunda reprovação permite demonstrar a sugestão de escalonamento, sem consumir tentativas por erros de rede.
12. O usuário aprova a mudança de perfil simulada, quando a política exigir.
13. Uma nova tentativa recebe o contexto correto, entrega evidência fictícia e é aprovada.
14. Coordenador conclui na Geral com referência à tarefa e à revisão.

Ofereça controles de demonstração fora do fluxo normal, discretos: “Avançar cenário”, “Executar automaticamente” e “Reiniciar demonstração”. A versão automática deve ter duração limitada, limpar seus timers e permitir pausa.

Adicione cenários curtos selecionáveis para:

- Agente desconectado e retomada.
- Permissão pendente, aprovada ou recusada.
- Evento duplicado após reconexão.
- Falha operacional sem reprovação de qualidade.

Não acrescente erros aleatórios que dificultem testar a interface. Os cenários devem ser reproduzíveis.

Rótulos como “testes passaram”, comandos executados e arquivos alterados nos exemplos precisam carregar a indicação de demonstração. Não produza evidência falsa de execução no computador do usuário.

### 20. Desempenho e percepção de carregamento

- Renderize a estrutura da aplicação cedo, com estado de carregamento visível.
- Evite uma tela totalmente branca enquanto carrega storage ou recursos secundários.
- Monte a conversa ativa e mantenha os contadores das demais abas de forma barata.
- Paginação ou virtualização para histórico longo, conforme a necessidade observada.
- Evite recalcular o histórico inteiro a cada fragmento de mensagem.
- Agrupe atualizações incrementais e persista em lotes quando adequado.
- Remova listeners e timers ao cancelar a assinatura, pausar o cenário ou desmontar a aplicação.
- Mantenha a navegação fluida enquanto chegam eventos.
- Não use polling frequente para simular uma arquitetura que já possui eventos.
- Não faça prewarm de vários agentes reais nesta entrega.

Crie uma opção de teste com, por exemplo, 2.000 eventos fictícios para avaliar navegação e histórico. Não carregue esse volume por padrão.

Registre o tamanho real do build e as verificações que conseguiu fazer. Não invente números de RAM, CPU, tokens ou latência. A aplicação React no navegador continuará consumindo recursos; o objetivo é medir e reduzir o trabalho necessário.

Não prometa desempenho de produção a partir do preview. O teste local posterior deve comparar inicialização, troca de abas e uso com zero, um e vários agentes.

### 21. Acessibilidade e interação

- Abas com semântica adequada, foco visível e navegação por teclado.
- Controles com nomes acessíveis e estados de desabilitado/ocupado corretos.
- Diálogos com foco e retorno ao elemento de origem.
- Respeitar leitores de tela e redução de movimento.
- Não anunciar cada fragmento de streaming de modo que torne o leitor de tela inutilizável.
- Rascunhos preservados ao trocar de aba.
- Enter para enviar e Shift+Enter para nova linha, com tratamento correto de composição de texto.
- Não roubar o foco do composer quando chega uma mensagem.
- Não forçar scroll para o fim se o usuário estiver lendo mensagens anteriores; oferecer “Novas mensagens”.
- Links e ações devem funcionar de verdade dentro do protótipo ou informar claramente por que estão indisponíveis.

### 22. O que fica fora da primeira versão

Mantenha apenas o necessário para validar a colaboração. Não incluir agora:

- Editor de código completo ou IDE embutida.
- Navegador integrado.
- Prévias de Word, planilhas, apresentações, PDF e vídeo.
- Canais de WhatsApp, Telegram, Discord ou mensageria empresarial.
- Agendamentos e cron.
- Loja de plugins, extensões ou marketplace.
- Geração de imagens e áudio.
- Multiplayer e colaboração entre usuários por nuvem.
- Banco e autenticação SaaS.
- Instalador de CLIs e login universal de fornecedores.
- Telemetria externa ou atualizador automático.
- Comparação de todos os chats lado a lado.

Não crie menus para esses recursos apenas para preencher a interface. A estrutura deve refletir as funções que realmente estamos implementando.

### 23. Critérios de aceitação

Considere esta entrega pronta quando for possível verificar:

1. Abrir o preview e ver uma estrutura útil durante o carregamento.
2. Entrar no projeto de demonstração e encontrar Geral como aba inicial.
3. Trocar entre Geral e agentes sem montar várias conversas lado a lado.
4. Enviar uma mensagem de demonstração ao destinatário correto.
5. Preservar rascunho e posição de leitura ao trocar de aba.
6. Acompanhar delegação, entrega, reprovação, correção e aprovação com vínculo à tarefa.
7. Abrir o detalhe a partir de um item da Geral e localizar sua origem.
8. Criar contexto v2 e distinguir pendente, entregue e aplicado por participante.
9. Confirmar que falha operacional não incrementa o contador de reprovação de qualidade.
10. Demonstrar escalonamento sem inventar modelo real ou chamada paga.
11. Demonstrar desconexão e retomada sem duplicar eventos já recebidos.
12. Resolver uma permissão simulada e verificar o efeito correto no estado.
13. Recarregar e recuperar o histórico persistido sem reiniciar tarefas automaticamente.
14. Exportar Markdown e JSON preservando referências.
15. Usar o fluxo principal por teclado.
16. Obter um build de produção do frontend sem erro, quando as ferramentas do ambiente permitirem.
17. Não depender de chave Gemini, login Google ou serviço pago para funcionar.
18. Identificar demonstração e integração real em todos os pontos relevantes.

Teste principalmente as regras de eventos, destinatários, recibos de contexto, contagem de tentativas, exportação e reconexão. Não escreva testes apenas para reproduzir a estrutura dos componentes. Inclua caminhos de falha.

Se algum critério não puder ser executado no ambiente, declare a limitação e entregue um passo de validação local. Não marque itens como testados por terem sido apenas implementados.

### 24. Entrega e forma de trabalhar

Comece com um resumo curto da arquitetura e implemente a aplicação no projeto do AI Studio. Não pare em um documento de planejamento ou em uma imagem estática.

Se a referência pública estiver inacessível, prossiga com o briefing e mantenha a integração real como pendente. Não fique bloqueado tentando baixar os monorepos inteiros.

Priorize o fluxo vertical completo: abrir conversa, enviar pedido, delegar, observar execução, revisar, concluir e recuperar histórico. Acrescente os detalhes de configurações e cenários após esse fluxo estar coeso.

Ao terminar, entregue:

- Preview funcional.
- Código React/TypeScript organizado e exportável.
- README com instalação, execução e build locais usando os scripts que realmente existem.
- Explicação curta de onde estão o domínio, o storage, o mock e a futura integração.
- Inventário das dependências e motivo das principais escolhas.
- Documento de integração com os recursos reaproveitáveis do AionCore e as extensões propostas.
- Lista do que foi implementado, efetivamente testado, simulado e ainda não conectado.

Não faça push, publicação ou deploy por conta própria. Não colete credenciais. Não implemente chamadas reais a agentes para fazer o protótipo parecer mais completo.

O resultado que quero avaliar é este: **abro o projeto, trabalho na conversa Geral, acompanho os agentes por abas, entendo as decisões e consigo confiar no histórico do que aconteceu — com uma aplicação pequena, clara e preparada para integração local.**

## FIM DO PROMPT

---

### Referência de uso do AI Studio

Documentação oficial consultada em 16/11/2026: https://aistudio.google.com/docs/aistudio-build-mode

O Build permite gerar aplicações web com frontend React, usar um runtime Node no servidor e exportar o código em ZIP. Este briefing escolhe um protótipo sem inferência ou serviços de nuvem como dependência do aplicativo gerado. O acesso ao Core no computador local será uma validação posterior à exportação.
