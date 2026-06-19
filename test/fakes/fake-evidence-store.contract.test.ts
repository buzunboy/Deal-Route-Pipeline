import { FakeEvidenceStore } from './fakes.js';
import { evidenceStoreContract } from '../contracts/evidence-store-contract.js';

/**
 * The in-memory fake must pass the SAME EvidenceStore contract as the production
 * LocalFsEvidenceStore (LSP). The unit suite swaps the fake in everywhere; if the
 * fake diverged (e.g. it accepted a hollow capture the real store rejects) those
 * tests would prove nothing about production behavior.
 */
evidenceStoreContract('FakeEvidenceStore', () => new FakeEvidenceStore());
