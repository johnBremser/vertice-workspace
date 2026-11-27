# Backlog do Vértice Workspace

Centralize nesta pasta as listas de backlog e as propostas de melhorias futuras do projeto. Atualize este índice ao adicionar, mover ou retirar uma lista.

## Listas e propostas

- [Melhorias e estabilização](melhorias.md): fila ativa de melhorias e estabilização (`BL-04` a `BL-09`; `BL-01` a `BL-03` concluídos e registrados no [CHANGELOG.md](../../CHANGELOG.md)).
- [Persistência em SQLite](sqlite-workspace-persistence.md): proposta de armazenamento local independente do navegador, com migração e controle de concorrência.
- [Worker local de orquestração](future-background-worker.md): proposta de continuidade dos fluxos autorizados sem depender de uma aba aberta.

## Convenção de manutenção

- Registre novas pendências em uma lista existente ou em um documento nesta pasta, com status, prioridade, dependências e critérios de aceite proporcionais ao escopo.
- Os demais documentos devem apontar para este índice ou para o item correspondente, mantendo a lista de pendências nesta pasta.
- Itens concluídos podem sair do backlog ativo. Preserve o registro da entrega e das verificações na documentação de progresso, entrega ou changelog correspondente, e ajuste os links e dependências que apontavam para o item.
- Preserve os identificadores dos itens remanescentes; não reutilize IDs retirados para outras melhorias.
- As propostas de SQLite e worker devem ser consideradas ao planejar persistência e recuperação, evitando trabalho sobreposto e registrando as dependências entre as entregas.
