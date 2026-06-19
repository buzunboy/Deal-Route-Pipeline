# Deal-record schema & extraction rules (always applies)

The deal record is the asset. It is **extensible by design**: a small typed core + open extension areas. The LLM **proposes**; it **never invents columns**.

## Shape
```json
{
  "id": "uuid", "schema_version": 1,
  "service": "Disney+", "route_type": "bundle|standalone|promo|regional",
  "provider": "Telekom MagentaTV", "headline": "...",
  "price": { "amount": 0, "currency": "EUR", "billing": "monthly" },
  "true_cost_monthly": 0, "country": "DE",
  "eligibility": {
    "new_customer_only": false, "residency_kyc": false,
    "plan_tier_required": "MagentaTV", "min_spend": null, "stackable": true,
    "conditions": [ { "key": "requires_other_product", "label": "...", "value": {}, "source_quote": "..." } ]
  },
  "validity": { "start": "...", "end": null, "recheck_days": 3,
    "conditions": [ { "key": "while_customer", "label": "...", "source_quote": "..." } ] },
  "included_items": ["..."], "attributes": {}, "raw_conditions_text": "...verbatim terms...",
  "source_url": "...", "evidence_id": "uuid", "confidence": 0.0,
  "grounding": [ { "field": "price", "quote": "...exact source sentence..." } ],
  "unmapped_conditions": false,
  "field_proposals": [ { "suggested_key": "...", "label": "...", "rationale": "...", "example_quote": "..." } ],
  "status": "candidate|in_review|published|expired|rejected",
  "verified_by": null, "verified_at": null
}
```

## Rules
- **Typed core** = the fields we filter/rank on (price, country, new_customer, plan_tier, stackable, validity dates). Parse these into fixed fields; if a flag is unclear, leave it null and add a condition — **never guess**.
- **Long-tail conditions** (eligibility + validity) → `conditions[]`, each mapped to a key in the **`condition_vocabulary`** table, with a `label` + `source_quote`. Keep `raw_conditions_text` verbatim; put unstructured extras in `attributes`. **Never drop information.**
- **New-field detection (governed loop):** a condition with no known vocabulary key → record it in `conditions[]` with `key:"other"`, set `unmapped_conditions:true`, and emit a `field_proposals` entry (`suggested_key`, `label`, `rationale`, `example_quote`). The pipeline counts proposals by `suggested_key`; recurring ones surface for a human to promote into the vocabulary (or a first-class field). **Ingestion is never blocked; the LLM never invents columns.**
- **Grounding required** for each key field (the exact source sentence) + a confidence score.
- **Boundary validation after the LLM:** schema check, sanity (price ranges, currency = EUR for DE, valid dates), then **dedupe/canonicalize** on `service + provider + route_type + country`. Low confidence or failed rules → must-review (**never auto-publish**).
- **`schema_version`** on every record, so promoted fields can be re-parsed from `raw_conditions_text` later.
