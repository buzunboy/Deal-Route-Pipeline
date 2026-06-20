import { describe, it, expect } from 'vitest';
import { HostedBrowserFetcher, HostedBrowserNotConfiguredError } from './hosted-browser-fetcher.js';

describe('HostedBrowserFetcher (scaffold)', () => {
  it('throws a clear typed error on fetch (not yet implemented)', async () => {
    const f = new HostedBrowserFetcher('key', 5000);
    await expect(f.fetch('https://example.de/x')).rejects.toBeInstanceOf(
      HostedBrowserNotConfiguredError,
    );
  });

  it('the error names the requested URL and points at the working alternatives', async () => {
    const f = new HostedBrowserFetcher('key', 5000);
    await expect(f.fetch('https://example.de/deal')).rejects.toThrow(
      /example\.de\/deal[\s\S]*FETCHER=browser/,
    );
  });

  it('close() is a no-op (no persistent resource yet)', async () => {
    await expect(new HostedBrowserFetcher('key', 5000).close()).resolves.toBeUndefined();
  });
});
