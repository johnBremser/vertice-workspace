# Avaliação futura — minimal-core

Status: ideia registrada para avaliação futura. Não integra o escopo da v1 e não autoriza iniciar análise detalhada, otimização ou fork agora.

Decisão registrada em 17/11/2026: continuar a entrega atual com o AionCore oficial completo. Depois de comprovar o produto com CLIs reais e estabilizar as funcionalidades necessárias, avaliar uma distribuição menor, provisoriamente chamada **minimal-core**.

## Objetivo da avaliação futura

Identificar recursos e dependências do AionCore que não sejam utilizados pelo produto nem necessários ao seu roadmap, e verificar se sua exclusão proporciona redução relevante de distribuição, consumo ou complexidade sem comprometer os fluxos suportados.

## Perguntas para essa avaliação

- Quais APIs, eventos, serviços e recursos são efetivamente utilizados? Quais dependências indiretas os sustentam?
- Quais capacidades não são utilizadas hoje, mas estão previstas no roadmap? Essas capacidades não devem ser excluídas apenas por ainda não estarem em uso.
- Quanto ocupam separadamente o executável, o runtime gerenciado, os adaptadores/CLIs, caches e dados? Reduzir o executável não significa reduzir todo o ambiente na mesma proporção.
- Quais ganhos podem ser obtidos com configuração, recursos opcionais de compilação e distribuição seletiva antes de manter alterações próprias no código?
- Quais seriam os custos de acompanhar atualizações, correções de segurança, migrações e contratos do upstream?

## Evidência necessária para uma decisão

Comparar a versão oficial com uma candidata usando os mesmos cenários e ambiente: tamanho comprimido e instalado, inicialização, RAM/CPU em repouso e com sessões ativas, estabilidade, instalação offline e regressões dos fluxos reais.

Preservar autenticação, permissões, isolamento, persistência, recuperação e contratos usados pelo produto. Não assumir que um módulo pode ser removido apenas pelo seu nome ou por não aparecer na interface. Não presumir que o runtime Node possa ser eliminado sem rastrear os caminhos que o utilizam.

## Resultado esperado do estudo futuro

Inventário de capacidades necessárias/opcionais, mapa de dependências, medições comparativas e recomendação fundamentada: continuar com o Core oficial, adotar uma compilação reduzida compatível ou propor uma variante própria com manutenção explícita.

A implementação de um minimal-core será uma decisão posterior ao estudo. Até lá, o plano v5 permanece baseado no Core oficial, sem modificações para redução de tamanho.
