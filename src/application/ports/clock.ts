/**
 * Clock port — injected time so use-cases are deterministic and testable. No
 * `new Date()` inside business logic (no hidden state, `code-style.md`).
 */
export interface Clock {
  now(): Date;
  /** ISO-8601 string for the current instant. */
  nowIso(): string;
}

/** Default real clock used by the composition root. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}
