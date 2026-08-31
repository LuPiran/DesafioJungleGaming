# Processador de apostas (Wagering Processor)

Serviço **backend** de apostas para o desafio técnico da Jungle Gaming. Não há frontend: o contrato é HTTP + SQS. Qualquer cliente (provedor de jogos, painel interno, script) fala com a API REST ou publica na fila.

O processador recebe transações financeiras de jogo (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), aplica as regras no domínio, persiste saldo e ledger na mesma transação SQL e publica eventos de integração de forma at-least-once.

Decisões de desenho, trade-offs e o que ficou de fora estão em [ARCHITECTURE.md](./ARCHITECTURE.md). Este README explica **como o sistema funciona e como rodá-lo**.

---

## O que este projeto resolve

Em iGaming o provedor reenvia a mesma aposta, mensagens SQS chegam fora de ordem e o processo pode morrer no meio do caminho. O serviço precisa, mesmo assim:

- nunca usar `number`/`float` para dinheiro;
- ser idempotente de verdade (persistido, não em memória);
- manter o saldo materializado igual ao ledger;
- serializar concorrência **por carteira**, não com um lock global;
- sobreviver a crash depois do commit e antes do ack da fila;
- mandar veneno para a DLQ e reprocessar `ROLLBACK`/`REFUND` que chegaram antes da `BET`.

Autenticação **não faz parte do recorte** (não pontua no desafio). Health e métricas ficam abertos. O ponto de extensão (`AuthGuard` + `ProviderIdentityPort`) está documentado em `ARCHITECTURE.md`.

---

## Stack

| Peça | Uso |
|------|-----|
| **Bun 1.x** | runtime e test runner |
| **NestJS 11** | HTTP, DI, workers no mesmo processo |
| **TypeScript strict** | `noUnusedLocals`, `noUncheckedIndexedAccess`, etc. |
| **PostgreSQL 16** | fonte da verdade (wallets, ledger, inbox, outbox) |
| **MikroORM 7** | UoW, `FOR UPDATE`, `SKIP LOCKED`, migrations versionadas |
| **decimal.js** | dinheiro com escala 2 e `ROUND_HALF_UP` |
| **AWS SQS FIFO** | entrada de apostas e eventos; no local, **LocalStack** |
| **Docker Compose** | Postgres + LocalStack + N instâncias da API |
| **Pino + Prometheus** | logs JSON e métricas |

---

## Como o sistema está organizado

Arquitetura hexagonal simples:

```
src/
  domain/           entidades, invariantes, eventos — zero Nest, zero ORM, zero `number` para dinheiro
  application/      ports + use cases (um use case de escrita para apostas)
  infrastructure/   MikroORM, SQS, Pino, Prometheus, auth no-op
  interfaces/       controllers HTTP e workers (consumer, outbox, pending-reference)
```

O mesmo `ProcessWagerTransactionUseCase` atende **HTTP e SQS**. A fila não tem um atalho de domínio.

Cada processo Nest sobe:

1. API HTTP;
2. consumidor da fila `wager-transactions.fifo`;
3. publisher da outbox (`SKIP LOCKED`);
4. worker de `PENDING_REFERENCE` (backoff exponencial).

Por isso `docker compose --scale app=3` são três réplicas completas, não um worker separado.

---

## Regras de domínio (resumo)

Dinheiro entra e sai como `{ "amount": "25.00", "currency": "BRL" }`. No banco: `NUMERIC(18,2)` + `CHAR(3)`.

| Kind | Efeito no saldo | Ledger | Referência |
|------|-----------------|--------|------------|
| `BET` | débito | 1 `DEBIT` | não |
| `WIN` | crédito | 1 `CREDIT` | opcional, mesma rodada |
| `LOSS` | nenhum | nenhum | não |
| `REFUND` | crédito | 1 `CREDIT` | `BET` `PROCESSED`, uma vez, mesmo valor |
| `ROLLBACK` | inverso da referência | 1 lançamento invertido | `BET`, `WIN` ou `REFUND` `PROCESSED`, uma vez, mesmo valor |
| `OPENING` | só na abertura da wallet | 1 `CREDIT` interno | **não** aceito via API/fila |

`Wallet.debit` e `Wallet.credit` são públicos; `apply()` escolhe a direção a partir do kind.

Estados: `PENDING` → `PROCESSED` | `PENDING_REFERENCE` | `REJECTED` | `FAILED`. Terminais não voltam atrás.

**Fora de ordem:** `ROLLBACK`/`REFUND` sem a referência ainda persistida vira `PENDING_REFERENCE` (HTTP **202**). Um worker reprocessa com backoff (`1s × 2^n`, teto configurável). Depois de **10 tentativas** (padrão de produção) a transação é `REJECTED` com `REFERENCE_NOT_FOUND`.

### Idempotência

Fonte da verdade: header **`Idempotency-Key`** (recomendado `{providerId}:{externalTransactionId}`).

`payloadHash` = SHA-256 do JSON canônico **só** dos campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`). Header, timestamps e transporte **não** entram no hash.

- mesma key + mesmo hash → replay (`idempotentReplay: true`);
- mesma key + hash diferente → **409** `IDEMPOTENCY_PAYLOAD_CONFLICT`;
- corrida de insert → unique no banco, a linha vencedora é relida.

### Concorrência

Unidade de contenção: **`walletId`**. `SELECT … FOR UPDATE` na linha da wallet dentro de `em.transactional()`. Carteiras distintas não se bloqueiam.

Cenário obrigatório: saldo `100.00`, duas `BET` de `80.00` ao mesmo tempo → uma `PROCESSED`, uma `REJECTED` (`INSUFFICIENT_FUNDS`), saldo `20.00`, **um** `DEBIT` no ledger.

### Inbox / outbox

Na **mesma transação SQL**: inbox (se a origem for SQS) + transação + saldo + ledger + outbox.

Ack SQS **depois** do commit. Eventos **nunca** saem antes do commit: o publisher lê linhas pendentes com `FOR UPDATE SKIP LOCKED` e manda para `wager-events.fifo`.

Se o processo morrer depois do commit e antes do ack:

- a mensagem volta a ficar visível;
- inbox + unique de idempotência impedem segundo débito;
- outra instância publica a outbox.

Erros de negócio são **ack** (já persistidos como `REJECTED`). Erros transitórios / payload venenoso **não** são ack → retry → DLQ (redrive nativo, **5** receives no Compose).

---

## Filas SQS

| Fila | Função |
|------|--------|
| `wager-transactions.fifo` | entrada `WagerTransactionRequested` (mesmo use case do HTTP) |
| `wager-transactions-dlq.fifo` | mensagens esgotadas (maxReceiveCount = 5 no ambiente Compose) |
| `wager-events.fifo` | eventos de integração (`WagerTransactionProcessed`, `Rejected`, `PendingReference`, `WalletBalanceChanged`) |

`MessageGroupId` = `walletId` (reduz reordenação). A consistência continua sendo do PostgreSQL. Deduplicação do broker é otimização; inbox + unique da transação são a garantia.

Envelope de entrada:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-08-31T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<WALLET_ID>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

`type` diferente de `WagerTransactionRequested` é erro transitório e acaba na DLQ.

---

## API HTTP

Base: `http://localhost:3000` (uma instância) ou `3000–3002` com `--scale app=3`.

Header opcional de correlação: `x-correlation-id` (se ausente, a API gera um UUIDv7 e devolve o mesmo header).

`Idempotency-Key` é **obrigatório** em `POST /wagering/transactions`.

### Wallets

```bash
# Abrir carteira (201)
curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -H 'x-correlation-id: demo-1' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

```bash
curl -s localhost:3000/wallets/<WALLET_ID>
curl -s "localhost:3000/wallets/<WALLET_ID>/ledger?limit=50"
curl -s -X POST localhost:3000/wallets/<WALLET_ID>/reconciliation
```

Ledger pagina por `cursor` / `limit` (máximo 100). Reconciliação **não corrige** divergência: devolve `consistent: false`, loga e incrementa métrica.

### Apostas

```bash
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<WALLET_ID>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

WIN / REFUND / ROLLBACK usam o mesmo endpoint; REFUND e ROLLBACK levam `referenceExternalTransactionId`.

Consultas:

```bash
curl -s localhost:3000/wagering/transactions/<TRANSACTION_ID>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

### Saúde e métricas (sem auth)

```bash
curl -s localhost:3000/health/live
curl -s localhost:3000/health/ready
curl -s localhost:3000/metrics
```

- `live`: processo no ar.
- `ready`: `SELECT 1` no Postgres + `GetQueueUrl` no SQS.
- `metrics`: Prometheus (transações por status/kind, duplicatas, retries, DLQ, outbox lag, latência, reconciliação).

### Status HTTP

| Situação | Código |
|----------|--------|
| Payload inválido / sem `Idempotency-Key` | 400 |
| Recurso inexistente | 404 |
| Conflito de idempotência ou wallet duplicada | 409 |
| Rejeição de regra de negócio (`failureCode` no corpo) | 422 |
| Aceite com `PENDING_REFERENCE` | 202 |
| Processado (ou replay idêntico) | 200 |
| Wallet criada | 201 |
| Falha transitória de infra | 503 |

Corpo de erro:

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "...",
    "retryable": false
  }
}
```

Códigos estáveis (o provedor deve ler `code`, não a mensagem): `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `IDEMPOTENCY_PAYLOAD_CONFLICT`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `DUPLICATE_WALLET`, `OPENING_NOT_ALLOWED`, `INVALID_KIND`, `INVALID_MONEY`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_SCOPE_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `TRANSACTION_NOT_FOUND`, `INFRA_PERMANENT`. Detalhe de cada um em [ARCHITECTURE.md](./ARCHITECTURE.md) §9.

---

## Observabilidade

Logs JSON (Pino). Campos recorrentes, **sem valores monetários** no fluxo feliz:

- `correlationId`
- `messageId` (SQS)
- `transactionId`
- `walletId`
- `providerId`

Eventos típicos: `http_request`, `wager_processed`, `sqs_message_received`, `sqs_transient_error`, `sqs_message_exhausted_to_dlq`. Bodies `money` / `initialBalance` são redacted.

Shutdown (`SIGTERM`): o consumer para de receber e espera in-flight (~25s). Nest com `enableShutdownHooks()`.

---

## Como rodar

### Pré-requisitos

- [Bun](https://bun.sh) 1.x — `curl -fsSL https://bun.sh/install | bash`
- Docker Engine + Compose
- Se o contexto Docker Desktop não estiver ativo neste Linux: `export DOCKER_HOST=unix:///var/run/docker.sock`

### Stack completo (recomendado para demo)

```bash
cp .env.example .env
docker compose up --build --scale app=3
```

| Serviço | Porta | Função |
|---------|-------|--------|
| PostgreSQL | 5432 | ledger, wallets, inbox, outbox |
| LocalStack | 4566 | filas FIFO + DLQ |
| app × 3 | 3000–3002 | API + consumer + outbox + pending-ref |

Migrations rodam no bootstrap (`runMigrations()` em `src/main.ts`).

### App no host, infra no Docker (desenvolvimento)

```bash
docker compose up postgres localstack
cp .env.example .env
bun install
bun run start:dev
```

API em `http://localhost:3000` com watch.

### PostgreSQL no host (opcional)

O caminho suportado pelo desafio é o Compose. Instalação nativa:

```bash
sudo apt-get install -y postgresql postgresql-contrib
chmod +x scripts/setup-host-postgres.sh
./scripts/setup-host-postgres.sh
```

Credenciais padrão: usuário / senha / db `wagering`. Ajuste `DATABASE_HOST=localhost` no `.env`.

---

## Variáveis de ambiente

Veja `.env.example`. As mais relevantes:

| Variável | Padrão | Significado |
|----------|--------|-------------|
| `PORT` | `3000` | HTTP |
| `DATABASE_*` | `wagering` @ `localhost:5432` | Postgres |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | LocalStack; omitir em AWS real |
| `SQS_WAGER_QUEUE_NAME` | `wager-transactions.fifo` | entrada |
| `SQS_WAGER_DLQ_NAME` | `wager-transactions-dlq.fifo` | DLQ |
| `SQS_EVENTS_QUEUE_NAME` | `wager-events.fifo` | outbox |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | invisibilidade após receive |
| `MAX_PENDING_REFERENCE_ATTEMPTS` | `10` | teto do worker |
| `AUTH_ENABLED` | `false` | guard no-op |
| `LOG_LEVEL` | `info` | Pino |

Workers podem ser desligados por processo (`SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED`) — usado nos testes.

---

## Comandos

| Comando | O que faz |
|---------|-----------|
| `bun install` | dependências |
| `bun run start:dev` | API + workers com watch |
| `bun run start` | um processo |
| `bun run typecheck` | `tsc --noEmit` strict |
| `bun run migration:up` | aplica migrations |
| `bun run migration:down` | reverte a última (reversível) |
| `bun run test:unit` | domínio (Money, Wallet, transações, hash) |
| `bun run test:integration` | Postgres + LocalStack reais (Testcontainers) |
| `bun run test:concurrency` | corridas com várias instâncias Nest |
| `bun run test:all` | as três suítes (sequencial; compartilham infra de teste) |
| `bun run test:load` | experimento de carga opcional |

### O que os testes cobrem

- **Unit:** `Money`, `Wallet.debit` / `credit` / `apply`, transações, ledger, hash canônico.
- **Integração HTTP:** invariantes, idempotência, 409 de payload, saldo insuficiente.
- **Integração messaging:** mesmo use case via SQS, redelivery sem segundo débito, outbox.
- **Falha / recuperação:** `ROLLBACK` antes da `BET` → worker completa `PROCESSED`; veneno → DLQ; crash após commit e antes do ack; restart do processo + reconciliação.
- **Concorrência:** 50 BETs iguais, corrida 100−80−80, wallets distintas em paralelo, **dois publishers de outbox** no mesmo banco.

Integração e concorrência sobem Postgres 16 e LocalStack via Testcontainers. Precisam do Docker (`DOCKER_HOST=unix:///var/run/docker.sock` se necessário).

### Carga (opcional)

Com o stack no ar:

```bash
bun run test:load
```

Variáveis: `LOAD_BASE_URL`, `LOAD_CONCURRENCY`, `LOAD_BETS`. Imprime throughput, p50/p95/p99 e taxa de erro. Não há meta de RPS — é um experimento reproduzível.

---

## Publicar uma aposta na fila (exemplo)

Com LocalStack no ar:

```bash
aws --endpoint-url=http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "<WALLET_ID>" \
  --message-deduplication-id "msg-123" \
  --message-body '{
    "messageId": "msg-123",
    "type": "WagerTransactionRequested",
    "occurredAt": "2026-08-31T12:00:00.000Z",
    "data": {
      "providerId": "provider-a",
      "externalTransactionId": "transaction-123",
      "idempotencyKey": "provider-a:transaction-123",
      "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      "walletId": "<WALLET_ID>",
      "roundId": "round-987",
      "gameId": "fortune-chimp",
      "kind": "BET",
      "money": { "amount": "25.00", "currency": "BRL" }
    }
  }'
```

---

## O que não entra neste repositório

- **Frontend** — o produto é o serviço financeiro. Não há UI, SPA nem pasta de cliente web no escopo entregue.
- **IdP / JWT** — auth desligada; ver `ARCHITECTURE.md` §2.
- **Reversão parcial**, OpenTelemetry, dashboard, replicação multi-região.

Se algo da tabela de pontos do desafio divergir do código, o documento de arquitetura descreve o porquê.
