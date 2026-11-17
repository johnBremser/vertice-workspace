# Roteiro de Validação Local (AionCore v0.2.2 + CLIs reais)

Este roteiro orienta a etapa local **após a exportação**, na máquina do usuário com o binário **AionCore `v0.2.2`** e os CLIs locais disponíveis.

---

## 1. Subir ambiente local limpo

```powershell
# No diretório extraído do pacote:
npm ci
npm run lint
npm test
npm run build
```

Para executar os testes E2E de navegador localmente pela primeira vez:

```powershell
npm run test:e2e:install
npm run test:e2e
```

---

## 2. Configurar origem segura e proxy para o AionCore

1. Suba o servidor/WebUI do AionCore `v0.2.2` localmente e anote a URL e porta exatas exibidas pelo processo.
2. Crie `.env.local` a partir de `.env.example`:
   ```env
   VITE_AIONCORE_BASE_URL=""
   VITE_AIONCORE_PROXY_TARGET="http://127.0.0.1:<PORTA_REAL_DO_CORE>"
   ```
3. Escolha o modo de execução local:
   - **Distribuição estática reproduzível (`V5-07`)**: execute `npm run build && npm run server:doctor && npm run server:start` e abra `http://127.0.0.1:4173` (ao terminar, encerre com `npm run server:stop`).
   - **Desenvolvimento**: execute `npm run dev` e abra `http://localhost:3000`.
4. Abra **Configurações** e siga a lista **Preparação guiada para operação real**:
   - Em **Modo de operação**, selecione **Modo AionCore local**.
   - Confirme `Base URL` vazio (para usar o proxy de mesma origem) e informe o caminho do workspace local desejado.

---

## 3. Validar saúde, autenticação e catálogo real

1. Clique em **Testar /health**: confirmar retorno HTTP 200 com `version` e `build_time`.
2. Clique em **Verificar /api/auth/status**.
3. Se `is_authenticated === false`, faça login no painel **Sessão AionCore Local** (as credenciais não são gravadas em cache, IndexedDB nem exportação JSON).
4. Clique em **Sincronizar catálogo (`/api/agents/management` e `/api/assistants`)**:
   - Confira na seção **Catálogo de conexões e adaptadores** os 6 estados de cada conexão (`Configurada`, `Core alcançável`, `Executável`, `Autenticação`, `Catálogo e modelos`, `Sessão`).
   - Verifique quais assistentes têm `assistant_id` válido (`team_selectable === true`) e quais modelos reais cada CLI (`codex`, `antigravity`, etc.) expôs.

---

## 4. Resolver equipe Terra 6.1 / Sol 6.1 / Gemini Hydrogen contra modelos reais

> **Importante**: `Terra 6.1`, `Sol 6.1` e `Gemini Hydrogen` são rótulos demonstrativos/preferências de participante no preset inicial (`preset_terra_sol_gemini` e `preset_terra_sol_split_gemini`). **Não são IDs fixos garantidos pela API de fornecedores.**

1. Crie uma nova conversa e selecione o preset desejado (`Terra 6.1 / Sol 6.1 / Gemini Hydrogen` ou a variação com **Sol Planejador** e **Sol Auditor** em sessões separadas).
2. Abra **Configurações → Equipe configurável, papéis e presets da conversa ativa**:
   - Vincule **Terra 6.1** (Coordenador) ao assistente `Codex` real do catálogo e selecione o ID de modelo confirmado retornado pelo Core.
   - Vincule **Sol 6.1** (Planejador e/ou Auditor) em uma **segunda instância/sessão** pela mesma conexão `Codex`, escolhendo o modelo confirmado desejado (igual ou diferente de Terra 6.1).
   - Vincule **Gemini Hydrogen** (Executor) ao assistente `Antigravity` real do catálogo e selecione um modelo confirmado pelo Core.
3. Clique em **Criar equipe no Core (`POST /api/teams`)** e confirme que:
   - O `externalTeamId` foi associado à conversa.
   - Cada participante recebeu um `slot_id` e um `conversation_id` próprios (duas sessões Codex distintas nunca compartilham histórico nem rascunho).
4. Conecte o canal WebSocket (**Conectar WS**) e envie uma orientação pela aba **Geral** (`POST /api/teams/{id}/messages`) e outra diretamente pela aba do executor (`POST /api/teams/{id}/agents/{slot_id}/messages`).

---

## 5. Verificações obrigatórias em execução real

- [ ] Receber eventos reais pelo WebSocket `{ name, data }` e confirmar atribuição à aba correta sem duplicação.
- [ ] Conferir se os eventos reais do WebSocket (`team.slotWorkChanged`, `message.stream`, `team.childTurnStarted`, `team.childTurnCompleted`, `team.childTurnCancelled`, `team.runFailed`, `team.taskChanged`, `team.mailboxChanged`) emitidos pelos CLIs locais correspondem aos mapeadores em `src/services/aionCoreAdapter.ts`.
- [ ] Testar criação de tarefa, publicação de contexto, ciclo completo de auditoria e decisão de permissão em uma tarefa pequena real no workspace.
- [ ] Testar queda/reconexão do WebSocket (`1008` / offline) e confirmar catch-up automático paginado (`/run-state`, `/mailbox`, `/tasks`, `/activity`), sinalização `incomplete` em falha parcial e ausência de fallback silencioso para simulação `demo`.
- [ ] Caso execute `npm test` em Windows, validar também o carregamento de `vite.config.ts` via `pathToFileURL` em `src/services/__tests__/viteProxyConfig.test.ts` se necessário no ambiente local.
