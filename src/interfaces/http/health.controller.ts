import { Controller, Get, Header } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { SqsService } from "../../infrastructure/messaging/sqs/sqs.service";
import { PrometheusMetrics } from "../../infrastructure/observability/metrics.service";

@Controller()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
    private readonly metrics: PrometheusMetrics,
  ) {}

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready() {
    await this.em.getConnection().execute("select 1");
    await this.sqs.ping();
    return { status: "ok", checks: { postgres: "up", sqs: "up" } };
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  async metricsEndpoint(): Promise<string> {
    return this.metrics.render();
  }
}
