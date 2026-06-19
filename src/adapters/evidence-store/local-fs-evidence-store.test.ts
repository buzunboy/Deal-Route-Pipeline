import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsEvidenceStore } from './local-fs-evidence-store.js';
import { evidenceStoreContract } from '../../../test/contracts/evidence-store-contract.js';

/**
 * Run the shared EvidenceStore contract against the local-fs adapter, proving it
 * is substitutable behind the port (LSP / `testing.md`: adapter contract tests).
 * A fresh temp dir per store keeps the write-once bundles isolated.
 */
evidenceStoreContract(
  'LocalFsEvidenceStore',
  () => new LocalFsEvidenceStore(mkdtempSync(join(tmpdir(), 'ev-contract-'))),
);
