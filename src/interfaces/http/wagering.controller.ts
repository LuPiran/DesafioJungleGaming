import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { GetTransactionUseCase } from "../../application/use-cases/query.use-cases";
import { SubmitWagerDto } from "./dto";
import { AuthGuard } from "../../infrastructure/auth/auth.guard";
import { ApplicationError } from "../../application/errors/application-error";
import { WagerTransactionStatus } from "../../domain/wager-transaction/enums";

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: SubmitWagerDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request & { correlationId?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new ApplicationError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
    }

    const started = Date.now();
    const result = await this.processWager.execute({
      ...body,
      idempotencyKey,
      correlationId: request.correlationId ?? idempotencyKey,
    });
    response.setHeader("x-processing-ms", String(Date.now() - started));
    response.status(statusFor(result.status));
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async byId(@Param("transactionId") transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async byExternal(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.getTransaction.byProviderExternal(providerId, externalTransactionId);
  }
}

function statusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 503;
    default:
      return 200;
  }
}
