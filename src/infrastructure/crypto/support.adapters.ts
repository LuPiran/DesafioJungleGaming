import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type {
  Clock,
  IdGenerator,
  PayloadHasher,
} from "../../application/ports/support";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  uuid(): string {
    return uuidv7();
  }
}

export class CanonicalSha256Hasher implements PayloadHasher {
  hash(value: unknown): string {
    const canonical = canonicalize(value);
    return createHash("sha256").update(canonical).digest("hex");
  }
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}
