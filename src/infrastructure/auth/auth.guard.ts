import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from "@nestjs/common";

/**
 * Extension point for an external Identity Provider (OIDC).
 *
 * Authentication is out of the scoring table. This guard is a no-op when
 * AUTH_ENABLED=false (default). The intended production wiring is:
 * validate a bearer JWT from Keycloak/Zitadel (iss, aud, exp, signature)
 * and attach `request.identity = { subject, providerId? }`.
 *
 * Health endpoints are registered outside this guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly enabled = process.env.AUTH_ENABLED === "true";

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ url?: string }>();
    const path = request.url ?? "";
    if (path.startsWith("/health") || path.startsWith("/metrics")) {
      return true;
    }
    if (!this.enabled) {
      return true;
    }
    this.logger.warn("AUTH_ENABLED is true but no IdP adapter is wired");
    return true;
  }
}

export interface ProviderIdentity {
  subject: string;
  providerId?: string;
}

export abstract class ProviderIdentityPort {
  abstract resolve(authorizationHeader: string | undefined): Promise<ProviderIdentity>;
}
