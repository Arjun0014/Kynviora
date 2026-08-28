# User Journeys and Information Architecture

Status: Product/UX source of truth
Last reviewed: 2026-08-29

## Navigation model

Use five primary destinations:

- Today - due medicines, appointments/tasks, urgent review items, quick add/scan.
- Shelf - medicines and personal-care products.
- Safety - current assessments, alerts, evidence changes, resolved history.
- Care - profiles, caregivers, Visit Pack, appointments, review workflows.
- You - account, privacy, consent, accessibility, notifications, exports/deletion.

Scan/add is an action available from Today and Shelf, not a sixth navigation destination.

## Persistent context

Any screen showing medicine, product, alert, document, or care information must make the
current profile/person clear. Switching profiles is an explicit action.

## Journey 1 - Add a medicine

1. Select profile.
2. Choose Add medicine.
3. Scan barcode/search/manual entry.
4. Kynviora shows identity candidates with source/confidence.
5. User confirms brand/generic name, strength, dosage form, market, and pack.
6. User captures/enters batch and expiry when available.
7. Optional label/prescription image is attached as evidence.
8. User enters schedule/refill details.
9. Review screen distinguishes confirmed, proposed, and missing fields.
10. Item is saved to Shelf.
11. Safety engine evaluates only approved rules using eligible confirmed context.
12. Product Trust Passport shows current confidence/coverage.

Required failure paths:

- barcode unsupported;
- no catalog result;
- multiple strengths;
- offline;
- image unreadable;
- permission denied;
- batch not visible;
- user chooses manual entry.

## Journey 2 - Add a personal-care product, including a product Kynviora has never seen

1. Select profile and choose Add personal-care product.
2. Scan barcode if present.
3. Kynviora checks the Living Catalog and approved identity sources.
4. If exact current formulation is already supported, show the candidate and ask the user to confirm that the package/market matches.
5. If it is missing, uncertain, or potentially stale, guide capture of the front/main panel, ingredient declaration, barcode/manufacturer panel, and batch/MFG/expiry area where applicable.
6. Image-quality checks reject blur/glare/unreadable text before expensive extraction.
7. Dedicated barcode decoding, OCR, and structured multimodal extraction produce field assertions with provenance/confidence.
8. Deterministic validators check dates, identifiers, units, and supported constrained fields.
9. The user confirms/corrects uncertain or material fields.
10. Kynviora normalizes supported ingredient names against canonical vocabularies while preserving the raw declaration.
11. The backend compares the normalized formulation fingerprint against the Living Catalog.
12. If the same formulation is known, link the observation and reuse the catalog record.
13. If it is genuinely new, create a candidate formulation with single-observation status.
14. If it conflicts with an existing formulation, show "possible formulation change" and create a new candidate/conflict instead of overwriting the old formula.
15. Safety Watch evaluates only rules whose required identity/provenance is satisfied.
16. Product Trust Passport shows identity, formula, batch, observation/corroboration, source coverage, and last check.
17. Global Regulatory Lens is available when canonical ingredient/product mappings and supported jurisdiction records exist.

Required failure paths:

- no barcode;
- barcode identifies company/product family but not formulation;
- OCR and multimodal extraction disagree;
- ingredient text cannot be normalized;
- source-grounded research finds no allowed evidence;
- same barcode with changed formula;
- offline capture;
- user refuses image upload/manual entry only.

## Journey 3 - Receive a medicine batch alert

1. Reviewed source record is published.
2. Matching engine finds exact/probable candidate items.
3. Assessment stores item/batch/source/rule versions.
4. Notification policy sends generic push if required.
5. User opens current alert from server-authorized context.
6. Alert explains:
   - exact medicine;
   - affected batch criteria;
   - whether their batch match is exact;
   - source/jurisdiction/date;
   - allowed next action language.
7. User records resolution or requests correction.
8. Safety Receipt preserves outcome and future corrections.

## Journey 4 - Personal-care ingredient concern

1. Profile contains an eligible confirmed/user-reported sensitivity for an approved rule.
2. Product has a sufficiently verified ingredient declaration.
3. Reviewed rule matches the relevant normalized ingredient/group.
4. Alert detail identifies the exact ingredient and why the rule is applicable.
5. Copy explains evidence limits and does not generalize the entire brand/product line.
6. User can inspect label evidence and correct the product/formula if wrong.
7. Resolution can include stopped using, not applicable, corrected formula, or professional
   discussion according to the rule's allowed actions.

## Journey 5 - Formula changed

1. User uploads/rescans a newer label or Kynviora receives reviewed manufacturer/catalog
   evidence.
2. New formulation version is created; old version remains historical.
3. Evidence Diff shows what changed.
4. Existing safety assessments are recomputed against the new version.
5. Material changes enter Safety or Review Inbox according to policy.

## Journey 6 - Caregiver invitation

1. Profile owner/admin chooses Add caregiver.
2. Selects profile(s), capabilities, and optional expiry.
3. Re-authenticates for sensitive grant creation.
4. Invitee accepts using their own account.
5. Grant becomes active and audit event is visible.
6. Caregiver sees only permitted data.
7. Owner can revoke at any time.
8. Revocation invalidates cached authorization on next access/sync.

## Journey 7 - Household Review Inbox

1. System/user creates a non-urgent quality/care task.
2. Today/Care displays task without safety-alert styling.
3. User understands why the task exists.
4. Completing it opens the authoritative record workflow.
5. Result updates product/profile data and triggers re-evaluation if needed.

## Journey 8 - Prepare a Visit Pack

1. Select upcoming visit/profile.
2. Kynviora proposes relevant current information.
3. User chooses exactly what to include.
4. Review screen shows content and sensitive-sharing warning.
5. Re-authenticate when policy requires.
6. Generate dated pack.
7. Share/print/export intentionally.
8. Audit export without logging sensitive content.

## Journey 9 - Correct a wrong safety match

1. User taps Report incorrect match.
2. Kynviora asks what appears wrong: item, batch, formula, profile context, or alert content.
3. User can correct their local/owned data immediately where allowed.
4. Report enters support/safety review queue if shared evidence/rule may be wrong.
5. Assessment is recomputed when authoritative inputs change.
6. User sees corrected/superseded history rather than the original alert disappearing.

## Journey 10 - Offline use

1. Device loses network.
2. User can still view current medicines, schedules, selected profile summary, personal-care
   shelf, and previously synchronized alerts with timestamps.
3. Low-risk edits create pending operations.
4. Safety screen clearly states last synchronization time and coverage limitation.
5. On reconnection, operations sync idempotently and server-authoritative safety/caregiver
   changes win according to defined conflict policy.

## Journey 11 - Review a formulation conflict

1. A new independent package observation matches an existing product/market but has a materially different ingredient declaration or medicine strength/form.
2. Kynviora re-runs extraction and deterministic comparison.
3. The system checks approved external identity/manufacturer sources if configured.
4. The user is told that a possible formulation change was detected, not that the prior record is necessarily wrong.
5. The new observation becomes a separate candidate formulation/conflict.
6. Shared catalog review/corroboration determines whether it becomes corroborated or externally verified.
7. Existing users are not silently migrated to the new formula. Their own package evidence/current-use record determines applicability.
8. Any assessments whose inputs changed are recomputed version-by-version.

## Journey 12 - Use Global Regulatory Lens

1. User opens a verified/corroborated product or normalized ingredient.
2. Kynviora requests the current Regulatory Lens projection.
3. The screen shows supported jurisdictions separately: India, EU, GB, NI, US, and Japan when coverage exists.
4. Each jurisdiction shows an explicit status such as prohibited, restricted, concentration/use condition, warning-required, product action, scientific opinion, no matched rule, or unknown.
5. Tapping a jurisdiction shows the exact condition, authority/source, legal/notice reference, effective/publication date, and Kynviora last-verified date.
6. The app explains when the package lacks concentration/use information needed to determine compliance.
7. The app does not call a foreign restriction a personal emergency merely because the user's home jurisdiction differs.
8. The user can open the underlying official reference where permitted and report a suspected incorrect mapping.

Required language rule: "No matched restriction found" must never render as "approved", "safe", or a green universal clearance.

## Screen-state requirements

Every critical route must define:

- loading;
- empty;
- success;
- partial/insufficient data;
- offline;
- permission denied;
- recoverable error;
- authorization lost;
- stale data;
- corrected/superseded data where applicable.

## Cognitive design rules

- One primary action on high-impact safety screens.
- No hidden swipe/long-press requirement for core actions.
- Do not use red as the only explanation of urgency.
- Avoid scientific jargon in the first layer; allow progressive evidence detail.
- Do not place uncertain and confirmed facts in identical visual treatment.
- Show the person's name/photo/identifier on family safety screens.
- Preserve drafts if capture is interrupted.
