import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response, Request } from "express";
import { ApplicationError } from "../../application/errors/application-error";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId =
      request.header("x-correlation-id") ??
      (request as Request & { correlationId?: string }).correlationId;

    if (exception instanceof ApplicationError) {
      this.logger.warn({
        msg: "http_application_error",
        correlationId,
        path: request.path,
        code: exception.code,
        status: exception.httpStatus,
      });
      response.status(exception.httpStatus).json({
        error: {
          code: exception.code,
          message: exception.message,
          retryable: exception.retryable,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === "string"
          ? payload
          : (payload as { message?: string | string[] }).message;
      response.status(status).json({
        error: {
          code: status === 400 ? "INVALID_PAYLOAD" : "HTTP_ERROR",
          message: Array.isArray(message) ? message.join("; ") : message ?? exception.message,
          retryable: false,
        },
      });
      this.logger.warn({
        msg: "http_exception",
        correlationId,
        path: request.path,
        status,
      });
      return;
    }

    this.logger.error({
      msg: "unhandled_exception",
      correlationId,
      path: request.url,
      error: exception instanceof Error ? exception.message : String(exception),
    });

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error",
        retryable: true,
      },
    });
  }
}
