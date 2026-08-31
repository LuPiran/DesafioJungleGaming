# Architecture

Processador de apostas distribuído. Este documento registra as decisões, os trade-offs e o que deliberadamente ficou de fora.

## 1. Forma do sistema

Hexágono simples, sem layers cerimoniais:

- **domain** — classes com construtor `private` e factories `create` / `open` / `from` / `rehydrate`. Sem NestJS, sem MikroORM, sem `number` para dinheiro.
- **application** — um use case de escrita para apostas (`ProcessWagerTransactionUseCase`), usado tanto pelo HTTP quanto pelo consumidor SQS. Ports para repositórios, UoW, relógio, IDs, hash e métricas.
- **infrastructure** — MikroORM (mapeadores explícitos), SQS, Pino, Prometheus.
- **interfaces** — controllers HTTP e três workers de processo: consumer SQS, publisher de outbox, reprocessador de `PENDING_REFERENCE`.

Reidratação **não** revalida transições. `rehydrate` só reconstrói estado já persistido.

## 2. Autenticação (fora da tabela de pontos)

**Decisão:** não integrar um IdP neste timebox. Autenticação não pontua e competiria com correção financeira, concorrência e idempotência.

**O que faria em produção:** Keycloak (OIDC) no Compose, bearer JWT validado (iss, aud, exp, assinatura JWKS). O ponto de extensão já existe:

- `AuthGuard` no-op com `AUTH_ENABLED=false`
- `ProviderIdentityPort` para resolver a identidade do provedor
- `/health/*` e `/metrics` permanecem abertos mesmo com o guard ligado

Mensagens SQS são canal interno confiável. A identidade do provedor **dentro da mensagem** continua sujeita às validações de domínio (`providerId`, escopo da referência, etc.).

## 3. Money e persistência

`Money` usa `decimal.js` com escala fixa de 2 e `ROUND_HALF_UP`. Entrada e JSON são sempre `{ amount: "25.00", currency: "BRL" }`.

Rejeitados em `Money.from`: vazio, notação científica, mais de 2 casas, `NaN`/`Infinity`, currency fora de `[A-Z]{3}`. Contratos HTTP ainda rejeitam negativo (`amount` ≥ `0.00`).

No PostgreSQL: `NUMERIC(18,2)` + `CHAR(3)`, **nunca** `float`/`double`. O domínio não conhece o tipo do ORM — o mapper converte string decimal ↔ `Money`.

O desafio inteiro roda em BRL, mas o modelo é multi-moeda: operação com currency diferente da wallet é `CURRENCY_MISMATCH`.

## 4. Schema — invariantes no banco

Garantias que não dependem de código de aplicação:

| Invariante | Constraint |
|------------|------------|
| Uma wallet por `playerId + currency` | `UNIQUE (player_id, currency)` |
| Saldo ≥ 0 | `CHECK (balance_amount >= 0)` |
| Escala monetária | `CHECK (scale(...) <= 2)` |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Ledger imutável / 1 lançamento por transação | sem `UPDATE`/`DELETE` no domínio; `UNIQUE (transaction_id)` no ledger |
| REFUND uma vez por referência | índice único parcial `(reference_transaction_id) WHERE kind = REFUND AND status = PROCESSED` |
| ROLLBACK uma vez por referência | análogo para `ROLLBACK` |
| Inbox | PK `(consumer_name, message_id)` |

Lançamentos do ledger **não são atualizados nem apagados**. `OPENING` só nasce no use case interno de abertura de wallet.

## 5. Concorrência

Unidade de contenção: **`walletId`**.

Estratégia: **`SELECT … FOR UPDATE`** na linha da wallet (lock pessimista por agregado) dentro de `EntityManager.transactional()`. Wallets distintas não se bloqueiam. Não há lock global.

Por que pessimista e não só optimistic:

- o cenário obrigatório (100 − 80 − 80) é contenção quente na mesma linha;
- retry otimista também funcionaria, mas o lock de linha torna o resultado determinístico sem janela de lost update;
- `version` continua existindo e só incrementa quando o saldo muda — trilha de auditoria e rede de segurança, não a trava principal.

`FOR UPDATE SKIP LOCKED` entra na outbox e no worker de `PENDING_REFERENCE`, para vários publishers/workers coexistirem sem duplicar o claim.

## 6. Idempotência

Fonte da verdade: header **`Idempotency-Key`** (recomendado `{providerId}:{externalTransactionId}`).

`payloadHash` = SHA-256 hex de JSON canônico (chaves ordenadas recursivamente, `null` para ausentes) do subconjunto de negócio:

`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`.

Header, timestamps e metadados de transporte **não** entram no hash.

- mesma key + mesmo hash → replay (`idempotentReplay: true`) com o saldo **observado na época**;
- mesma key + hash diferente → **409** `IDEMPOTENCY_PAYLOAD_CONFLICT`;
- corrida de insert → unique violation → relê a linha vencedora.

Não há cache in-memory de idempotência.

## 7. Inbox / outbox / atomicidade

Na **mesma transação SQL**:

1. inbox (se a entrada for SQS);
2. transação de aposta;
3. saldo da wallet;
4. lançamento de ledger (se houver efeito);
5. linhas de outbox com os eventos.

Ack SQS **depois** do commit. Eventos **nunca** são publicados antes do commit — só o worker de outbox lê linhas pendentes e publica em `wager-events.fifo`.

Se o processo morrer após o commit e antes do ack/publish:

- a mensagem SQS volta a ficar visível; inbox + idempotency key impedem segundo efeito;
- outra instância reclama a outbox com `SKIP LOCKED` e publica;
- republicação é segura para o consumidor (mesmo `eventId` / `MessageDeduplicationId` = id da outbox).

DLQ: redrive nativo do SQS após 5 receives. Erros de negócio são **ack** (já persistidos como `REJECTED`). Erros transitórios não são ack.

Shutdown (`SIGTERM`): o consumer para de receber e espera in-flight (até ~25s) antes de sair. Nest `enableShutdownHooks()`.

## 8. Máquina de estados da transação

```
PENDING ─┬─► PROCESSED
         ├─► PENDING_REFERENCE ─┬─► PROCESSED
         │                      └─► REJECTED (referência esgotada)
         ├─► REJECTED
         └─► FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais. Tentar transicionar a partir deles é `InvalidTransactionStateError` (bug, não fluxo de negócio).

`OPENING` é interno e já nasce `PROCESSED`.

### Efeitos

| Kind     | Saldo   | Ledger        | Referência |
|----------|---------|---------------|------------|
| BET      | débito  | 1 DEBIT       | não        |
| WIN      | crédito | 1 CREDIT      | opcional, mesma rodada |
| LOSS     | nenhum  | nenhum        | não        |
| REFUND   | crédito | 1 CREDIT      | BET PROCESSED, uma vez, valor igual |
| ROLLBACK | inverso | 1 invertido   | BET, WIN ou REFUND PROCESSED, uma vez, valor igual |

Interpretação adicional (documentada): além da unicidade por **tipo**, um BET já revertido por REFUND não pode ser alvo de ROLLBACK (e vice-versa). Dois créditos sobre a mesma aposta violariam a correção financeira. ROLLBACK de um REFUND continua válido — desfaz o estorno.

Referência fora de ordem: persiste `PENDING_REFERENCE` e um worker reprocessa com backoff exponencial (`1s × 2^n`, teto via config). Limite: **10 tentativas** (~17 min). Esgotado: `REJECTED` + `REFERENCE_NOT_FOUND`. Justificativa: janela suficiente para a BET chegar em entrega at-least-once sem prender saldo indefinidamente.

## 9. Códigos de falha

Estáveis e legíveis por máquina. O provedor usa o código, não a mensagem.

| Código | Significado | Reenviar? |
|--------|-------------|-----------|
| `INSUFFICIENT_FUNDS` | BET sem saldo | não, a menos que o saldo mude |
| `REVERSAL_WOULD_OVERDRAW` | REFUND/ROLLBACK deixaria saldo negativo | não (operacionalmente distinto de aposta sem saldo) |
| `IDEMPOTENCY_PAYLOAD_CONFLICT` | mesma key, payload diferente | corrigir payload / key |
| `WALLET_NOT_FOUND` | wallet inexistente | criar wallet |
| `CURRENCY_MISMATCH` | moeda da operação ≠ wallet | corrigir |
| `DUPLICATE_WALLET` | `playerId+currency` já existe | usar a existente |
| `OPENING_NOT_ALLOWED` | OPENING pela API/fila | nunca |
| `INVALID_KIND` / `INVALID_MONEY` | contrato | corrigir |
| `REFERENCE_REQUIRED` | REFUND/ROLLBACK sem referência | corrigir |
| `REFERENCE_NOT_FOUND` | TTL esgotado | a referência não chegou |
| `REFERENCE_NOT_PROCESSED` | referência ainda não PROCESSED | esperar / reenviar depois |
| `REFERENCE_KIND_NOT_ALLOWED` | REFUND≠BET, ROLLBACK fora do conjunto | corrigir |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ referência | corrigir (parcial fora de escopo) |
| `REFERENCE_SCOPE_MISMATCH` | provider/player/wallet/rodada | corrigir |
| `REFERENCE_ALREADY_REVERSED` | reversão duplicada | não |
| `TRANSACTION_NOT_FOUND` | consulta | — |
| `INFRA_PERMANENT` | falha de infra não retryable | DLQ / ops |

## 10. Eventos

Envelope `IntegrationEvent<T>` com `eventType` e `version` na classe, não no call site. `data` carrega `MoneyProps` (string), nunca a instância `Money`.

| Evento | Quando |
|--------|--------|
| `WagerTransactionProcessed` | qualquer aplicação, inclusive LOSS |
| `WagerTransactionRejected` | rejeição de negócio |
| `WalletBalanceChanged` | somente se o saldo mudou |
| `WagerTransactionPendingReference` | primeira espera por referência |

## 11. Observabilidade

- Logs JSON (Pino) com `correlationId` (`x-correlation-id`), sem body financeiro (redact de `money` / `initialBalance`).
- Métricas Prometheus em `GET /metrics`: transações por status/kind, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência, reconciliação.
- `GET /health/live` — processo vivo.
- `GET /health/ready` — `SELECT 1` no Postgres + `GetQueueUrl` no SQS.

Divergência de reconciliação **não é corrigida**: log de erro + métrica + `consistent: false` na resposta.

## 12. Trade-offs e limitações

- **Pessimista vs. otimista:** escolhemos lock de linha. Em wallets extremamente quentes isso serializa o agregado — correto para dinheiro, não é o máximo de throughput.
- **SQS FIFO:** `MessageGroupId = walletId` reduz reordenação. A consistência continua sendo do Postgres. Deduplicação do broker é otimização; inbox + unique da transação são a garantia.
- **Outbox polling** (não LISTEN/NOTIFY): mais simples, funciona com várias instâncias, introduz lag de centenas de ms. Aceitável para eventos de integração.
- **Auth ausente:** ver seção 2.
- **Uma região / um Postgres:** sem replicação cross-region nem outbox relay multi-DC.
- **Reversão parcial:** fora de escopo.
- **OpenTelemetry / dashboard:** não incluídos; métricas e logs bastam para o recorte.
- **IdP e mTLS da fila:** a fila é confiável por premissa do desafio.

## 13. Por que MikroORM

Unit of Work e Identity Map explícitos, `em.transactional()`, `LockMode.PESSIMISTIC_WRITE` e `PESSIMISTIC_PARTIAL_WRITE` (`SKIP LOCKED`) mapeiam direto para o modelo mental do desafio. TypeORM seria aceitável; Prisma está fora do enunciado e esconde o UoW.
