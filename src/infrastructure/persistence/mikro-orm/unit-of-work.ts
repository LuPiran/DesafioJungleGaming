import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import type { UnitOfWork } from "../../../application/ports/unit-of-work";
import { UniqueConstraintError } from "../../../application/errors/unique-constraint-error";

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.em.transactional(async () => work());
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException || isPgUniqueViolation(error)) {
        throw new UniqueConstraintError();
      }
      throw error;
    }
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === "23505") {
    return true;
  }
  return typeof candidate.message === "string" && candidate.message.includes("duplicate key");
}
