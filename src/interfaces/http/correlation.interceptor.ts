import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable, tap } from "rxjs";
import { v7 as uuidv7 } from "uuid";

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  private readonly logger = new Logger("Http");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { correlationId?: string }>();
    const response = http.getResponse<Response>();
    const incoming = request.header("x-correlation-id");
    const correlationId = incoming && incoming.length > 0 ? incoming : uuidv7();
    request.correlationId = correlationId;
    response.setHeader("x-correlation-id", correlationId);

    const body = request.body as Record<string, unknown> | undefined;
    return next.handle().pipe(
      tap((data) => {
        const payload = data as Record<string, unknown> | undefined;
        this.logger.log({
          msg: "http_request",
          correlationId,
          method: request.method,
          path: request.path,
          status: response.statusCode,
          walletId: (body?.walletId ?? request.params["walletId"]) as string | undefined,
          providerId: body?.providerId as string | undefined,
          transactionId:
            (payload?.transactionId as string | undefined) ?? request.params["transactionId"],
          messageId: request.header("x-message-id"),
        });
      }),
    );
  }
}
