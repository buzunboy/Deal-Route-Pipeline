import type { Logger } from '../../application/ports/index.js';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

/** Structured console logger (JSON lines). Filtered by a minimum level. */
export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: Level = 'info') {}

  debug(msg: string, context?: Record<string, unknown>): void {
    this.log('debug', msg, context);
  }
  info(msg: string, context?: Record<string, unknown>): void {
    this.log('info', msg, context);
  }
  warn(msg: string, context?: Record<string, unknown>): void {
    this.log('warn', msg, context);
  }
  error(msg: string, context?: Record<string, unknown>): void {
    this.log('error', msg, context);
  }

  private log(level: Level, msg: string, context?: Record<string, unknown>): void {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.minLevel)) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...context });
    (level === 'error' ? console.error : console.log)(line);
  }
}
