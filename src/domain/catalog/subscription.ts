import { z } from 'zod';
import { Country } from '../deal-record/enums.js';

/**
 * A target subscription in the catalog (the ~25 services we track for Germany
 * v1). Provider pages seed Lane A; the service names drive Tier-3 community
 * keyword matching. `service` is the canonical name deals are matched against.
 */
export const SubscriptionCatalogEntrySchema = z.object({
  service: z.string().min(1),
  category: z.string().min(1),
  provider_url: z.string().url(),
  country: Country,
});
export type SubscriptionCatalogEntry = z.infer<typeof SubscriptionCatalogEntrySchema>;
