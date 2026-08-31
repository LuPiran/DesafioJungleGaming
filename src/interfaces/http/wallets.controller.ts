import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { OpenWalletUseCase } from "../../application/use-cases/open-wallet.use-case";
import {
  GetLedgerUseCase,
  GetWalletUseCase,
} from "../../application/use-cases/query.use-cases";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";
import { OpenWalletDto } from "./dto";
import { AuthGuard } from "../../infrastructure/auth/auth.guard";

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getLedger: GetLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: OpenWalletDto,
    @Req() request: Request & { correlationId?: string },
  ) {
    return this.openWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId: request.correlationId ?? "http",
    });
  }

  @Get(":walletId")
  async find(@Param("walletId") walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit = "50",
  ) {
    const parsed = Number.parseInt(limit, 10);
    return this.getLedger.execute(walletId, cursor, Number.isFinite(parsed) ? parsed : 50);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconciliation(@Param("walletId") walletId: string) {
    return this.reconcile.execute(walletId);
  }
}
