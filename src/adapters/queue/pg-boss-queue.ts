import PgBoss from 'pg-boss';
import type { Queue, JobHandler } from '../../application/ports/index.js';

/**
 * pg-boss Queue adapter (Postgres-backed) — the durable production scheduler/
 * queue. Jobs are retried by pg-boss; handlers should be idempotent. Same `Queue`
 * port as the in-memory adapter, so the pipeline code is unchanged.
 */
export class PgBossQueue implements Queue {
  private readonly boss: PgBoss;
  private started = false;

  constructor(connectionString: string) {
    this.boss = new PgBoss(connectionString);
  }

  async start(): Promise<void> {
    if (!this.started) {
      await this.boss.start();
      this.started = true;
    }
  }

  async publish<T>(name: string, data: T): Promise<void> {
    await this.boss.send(name, data as object);
  }

  async subscribe<T>(name: string, handler: JobHandler<T>): Promise<void> {
    await this.boss.work<T>(name, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.boss.stop();
      this.started = false;
    }
  }
}
