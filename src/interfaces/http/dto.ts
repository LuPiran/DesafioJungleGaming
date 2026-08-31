import { Type } from "class-transformer";
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { WagerTransactionKind } from "../../domain/wager-transaction/enums";

const AMOUNT_RE = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MoneyDto {
  @IsString()
  @Matches(AMOUNT_RE, { message: "amount must be a non-negative decimal with exactly 2 places" })
  amount!: string;

  @IsString()
  @Matches(CURRENCY_RE, { message: "currency must be an ISO-4217 code" })
  currency!: string;
}

export class OpenWalletDto {
  @Matches(UUID_RE)
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class SubmitWagerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  providerId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  externalTransactionId!: string;

  @Matches(UUID_RE)
  playerId!: string;

  @Matches(UUID_RE)
  walletId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  roundId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  gameId!: string;

  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
