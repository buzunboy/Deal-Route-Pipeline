import type { Queue, JobHandler } from '../../application/ports/index.js';

/**
 * In-memory Queue adapter. Runs handlers synchronously on publish — enough to
 * drive the pipeline in dry-run/dev/CI without Postgres. The pg-boss adapter is
 * the durable production implementation behind the same port (LSP).
 */
export class InMemoryQueue implements Queue {
  private handlers = new Map<string, JobHandler<unknown>>();

  async publish<T>(name: string, data: T): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) return;
    await handler(data);
  }

  async subscribe<T>(name: string, handler: JobHandler<T>): Promise<void> {
    this.handlers.set(name, handler as JobHandler<unknown>);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
