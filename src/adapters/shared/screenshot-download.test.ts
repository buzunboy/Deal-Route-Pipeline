import { describe, it, expect } from 'vitest';
import { resolveScreenshotBytes, MAX_SCREENSHOT_BYTES } from './screenshot-download.js';

const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

describe('resolveScreenshotBytes', () => {
  it('decodes a data: URI to non-empty bytes', async () => {
    const bytes = await resolveScreenshotBytes(PNG_DATA_URI, 1000);
    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBeGreaterThan(0);
  });

  it('returns null for an undefined ref (no screenshot)', async () => {
    expect(await resolveScreenshotBytes(undefined, 1000)).toBeNull();
  });

  it('returns null for an empty data: URI (never empty bytes — evidence invariant)', async () => {
    expect(await resolveScreenshotBytes('data:image/png;base64,', 1000)).toBeNull();
  });

  it('returns null for an over-cap data: URI', async () => {
    const huge = 'A'.repeat(MAX_SCREENSHOT_BYTES * 2); // base64 of >cap bytes
    expect(await resolveScreenshotBytes(`data:image/png;base64,${huge}`, 1000)).toBeNull();
  });

  it('returns null (never throws) for a garbage ref', async () => {
    expect(await resolveScreenshotBytes('not-a-url-or-datauri', 1000)).toBeNull();
  });
});
