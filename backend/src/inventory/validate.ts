import { BadRequestException } from "@nestjs/common";

// Money/quantity are NEVER floats at any boundary — always decimal strings.
const DECIMAL_RE = /^\d{1,12}(\.\d{1,4})?$/;

export function assertDecimal(value: unknown, name: string, opts: { allowZero: boolean }): string {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    throw new BadRequestException(`${name} must be a decimal string (up to 4 dp)`);
  }
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || (!opts.allowZero && n === 0)) {
    throw new BadRequestException(`${name} must be ${opts.allowZero ? "non-negative" : "positive"}`);
  }
  return value;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
  return value.trim();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new BadRequestException(`${name} must be a YYYY-MM-DD date`);
  }
  return value;
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}
