# Direção visual — workspace web de agentes

Data: 17/11/2026. Direção para V5-01. Identidade aprovada: **Vértice Workspace**. Slogan: **Seu time de agentes, do plano à entrega.** Assinatura técnica: **Powered by AionCore**. Aplicar na apresentação sem renomear banco, diretório ou protocolo.

## Diagnóstico da interface atual

A interface funciona, mas há muitos elementos com o mesmo peso: toolbar com vários botões preenchidos, abas com nome/papel/estado em uma linha longa, eventos de sistema em cartões semelhantes às mensagens e metadados técnicos sempre expostos. A conversa ocupa o centro, mas o conjunto lembra um painel administrativo. Alterar somente a cor não resolve essa composição.

## Direção recomendada

Um workspace sóbrio e contemporâneo para desenvolvimento, com leitura confortável, hierarquia clara e informação sob demanda. Referências de linguagem: precisão e densidade de ferramentas de desenvolvimento modernas; não copiar marcas, telas ou componentes de outro produto.

### Composição

- Sidebar de aproximadamente 232–248 px: marca discreta, projeto ativo, conversas, ação nova conversa e configurações no rodapé. Sem botão de edição/arquivo em cada linha o tempo todo; ações contextuais continuam acessíveis por teclado e menu.
- Topo em duas camadas leves: breadcrumb/projeto e título; ações secundárias no menu. Um estado principal por execução. Exportar/backup e demonstração não competem com a conversa.
- Equipe em abas compactas: Geral, nome do participante e papel principal em segunda linha. Modelo, demais papéis e diagnóstico no detalhe. Estado combina texto e sinal visual; não depender só de cor. Contadores de novidades continuam corretos.
- Centro: conversa com largura útil aproximada de 760–880 px, espaçamento editorial e autoria identificável. Usuário, agente e evento de sistema têm tratamentos diferentes. Eventos rotineiros são linhas de timeline; entregas, decisões e permissões podem usar superfície própria.
- Lado direito: painel contextual de 300–340 px com abas Trabalho/Contexto, recolhível, usando tarefas e recibos reais. Não construir um segundo gerenciador de tarefas. Em largura intermediária, transformar em drawer; no mobile, painel sobreposto com foco controlado.
- Composer ancorado visualmente à conversa, com caixa de 12–14 px de raio, destinatário legível, opção de contexto e envio evidentes. Preservar Enter/Shift+Enter, composição IME e rascunho por aba. A mensagem da Geral continua destinada ao coordenador; não insinuar broadcast automático.

### Tipografia e ritmo

Usar inicialmente a pilha local `system-ui/Segoe UI`, sem fontes externas obrigatórias. Corpo 14–15 px e entrelinha confortável; títulos de tela 20–24 px; rótulos secundários 12–13 px. Monoespaçada apenas em código, caminhos, IDs e métricas técnicas. Evitar quase toda a interface em 11–12 px.

Usar escala de espaçamento 4/8/12/16/24/32, raios coerentes e controles entre 32–40 px no desktop, com alvo de toque de 44 px nas superfícies móveis. Linhas e menus podem ser compactos sem reduzir a área acionável.

### Cor e superfícies

Reaproveitar os tokens semânticos existentes. Proposta para referência escura: canvas `#101216`, sidebar `#14171C`, superfície `#191D24`, superfície elevada `#202630`, borda `#2B323D`, texto `#EDF1F7`, texto secundário `#ABB5C4`, destaque `#6DD8C5`. A ação principal usa texto escuro sobre o destaque claro.

Tema claro: canvas `#F5F7FA`, superfícies brancas, texto `#18212D`, texto secundário `#526072`, bordas `#DCE2EA`, destaque `#126F63`. Validar contraste nos componentes finais; a paleta não substitui essa verificação.

Neutralidade na maior parte da tela; destaque para seleção/ação e cores semânticas para sucesso, aviso e falha. Não atribuir uma cor diferente a cada provedor. Sem neon, glassmorphism, gradientes decorativos, sombras fortes, fontes futuristas ou animação contínua. Transições de 120–180 ms, respeitando reduced motion.

### Transparência e estados

O indicador de demonstração precisa continuar visível na tela, mesmo após recolher os controles. Modo real não significa agente autenticado. O painel não pode apresentar conexão, tarefa aprovada ou recibo aplicado sem estado real correspondente.

Nunca esconder permissão pendente, perda de persistência, falha ou reconciliação incompleta apenas para limpar a tela. Agrupar avisos informativos, mas manter o estado que exige ação acessível e perceptível.

### Configurações

Organizar as seções existentes por conexão/runtime, equipe e papéis, política e aparência/dados. Preferir resumo com expansão a formulários extensos simultaneamente abertos. Endpoints, IDs e capacidades técnicas ficam em diagnóstico, mantendo acesso para investigação.

## Limites desta alteração

Manter React/TypeScript/Tailwind, lucide, tokens, pt-BR e todos os contratos. Não trocar bibliotecas, nomes de banco, protocolo ou DTOs; não redesenhar as regras do motor junto com a interface. Não incluir cards de custo, velocidade ou progresso percentuais sem dados medidos.

`workspace-reference.html` é uma maquete estática com conteúdo ilustrativo rotulado, para discutir composição. Os botões demonstrativos selecionam abas e o tema; não há conexão ao Core. Não importar o HTML inteiro como página da aplicação. Não copiar tarefas, tempos ou status de exemplo como estado inicial real.

## Aceite

1. Conferir desktop 1440×900, notebook 1024×768 e mobile 390×844 em claro/escuro, sem overflow da página; scroll de código é interno.
2. Conferir estados reais/simulados, execução, bloqueio, falha, conclusão, novidades, contexto e sem persistência.
3. Verificar navegação por teclado, foco de menus/modais/drawers, labels e contraste. Ícone sem texto precisa de nome acessível.
4. Reexecutar tipos, testes e Playwright existente; atualizar seletores somente quando a intenção do comportamento continuar coberta. Não remover assertivas para acomodar regressão.
5. Entregar capturas antes/depois da mesma conversa e lista das alterações, sem misturar integração Core neste marco.
