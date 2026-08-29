/**
 * Branded entity identifiers.
 *
 * `07_DOMAIN_MODEL.md`: "Every durable entity uses a non-guessable ID, timestamps,
 * version/revision, lifecycle state, and provenance."
 *
 * Branding exists because the domain deliberately keeps eight product layers separate
 * (`08`: commercial identity / marketed variant / formulation / batch / observation / owned item
 * / catalog evidence / regulatory knowledge) and "a match at one layer never proves all lower
 * layers". Passing a `ProductIdentityId` where a `MarketedFormulationId` is required is exactly
 * the class of bug that would silently claim a barcode proves a formula. Branding makes that a
 * compile error rather than a code-review responsibility.
 *
 * `15` also notes unguessable IDs are *not* a security control on their own - authorization is
 * still checked server-side on every request. Branding is a correctness tool, not a security one.
 */

declare const brand: unique symbol;

/** Attach a nominal brand to a string type. */
export type Branded<TBrand extends string> = string & { readonly [brand]: TBrand };

// --- Identity and access -----------------------------------------------------
export type UserId = Branded<'UserId'>;
export type HouseholdId = Branded<'HouseholdId'>;
export type ProfileId = Branded<'ProfileId'>;
export type CaregiverGrantId = Branded<'CaregiverGrantId'>;
export type CaregiverInvitationId = Branded<'CaregiverInvitationId'>;
export type ConsentReceiptId = Branded<'ConsentReceiptId'>;
export type AuditEventId = Branded<'AuditEventId'>;
export type SessionId = Branded<'SessionId'>;

// --- Profile context ---------------------------------------------------------
export type AllergyRecordId = Branded<'AllergyRecordId'>;
export type ConditionRecordId = Branded<'ConditionRecordId'>;

// --- User-owned items --------------------------------------------------------
export type OwnedItemId = Branded<'OwnedItemId'>;
export type ProductUsageEvidenceId = Branded<'ProductUsageEvidenceId'>;

// --- Living Catalog ----------------------------------------------------------
export type ProductIdentityId = Branded<'ProductIdentityId'>;
export type MarketedFormulationId = Branded<'MarketedFormulationId'>;
export type BatchOrLotId = Branded<'BatchOrLotId'>;
export type CaptureSessionId = Branded<'CaptureSessionId'>;
export type EvidenceAssetId = Branded<'EvidenceAssetId'>;
export type ExtractionRunId = Branded<'ExtractionRunId'>;
export type FieldAssertionId = Branded<'FieldAssertionId'>;
export type ProductObservationId = Branded<'ProductObservationId'>;
export type CatalogConflictId = Branded<'CatalogConflictId'>;
export type CatalogCorrectionId = Branded<'CatalogCorrectionId'>;

/**
 * A formulation fingerprint (DEC-015).
 *
 * Branded separately from every entity ID because `08` is explicit that a fingerprint "is not a
 * cryptographic proof that two physical products are identical. It is a fast signal". Making it
 * a distinct type means `if (fp === formulationId)` cannot compile, so a fingerprint match can
 * never be mistaken for an identity match.
 */
export type FingerprintHash = Branded<'FingerprintHash'>;

// --- Medicine care -----------------------------------------------------------
export type MedicineScheduleId = Branded<'MedicineScheduleId'>;
export type DoseEventId = Branded<'DoseEventId'>;
export type RefillEstimateId = Branded<'RefillEstimateId'>;
export type ReconciliationId = Branded<'ReconciliationId'>;

// --- Care --------------------------------------------------------------------
export type AppointmentId = Branded<'AppointmentId'>;
export type ReviewTaskId = Branded<'ReviewTaskId'>;
export type VisitPackId = Branded<'VisitPackId'>;

// --- Sources and evidence ----------------------------------------------------
export type SourceRegistryEntryId = Branded<'SourceRegistryEntryId'>;
export type SourceDocumentId = Branded<'SourceDocumentId'>;
export type SourceDiscoveryCandidateId = Branded<'SourceDiscoveryCandidateId'>;
export type EvidenceClaimId = Branded<'EvidenceClaimId'>;
export type NormalizedSubstanceId = Branded<'NormalizedSubstanceId'>;
export type ScientificOpinionId = Branded<'ScientificOpinionId'>;

// --- Global Regulatory Registry ----------------------------------------------
export type RegulatoryRuleVersionId = Branded<'RegulatoryRuleVersionId'>;
export type RegulatoryStatusRecordId = Branded<'RegulatoryStatusRecordId'>;
export type ProductRegulatoryActionId = Branded<'ProductRegulatoryActionId'>;
export type RegulatoryLensSnapshotId = Branded<'RegulatoryLensSnapshotId'>;
export type CitationGateDecisionId = Branded<'CitationGateDecisionId'>;

// --- Safety assessment -------------------------------------------------------
export type AssessmentRuleVersionId = Branded<'AssessmentRuleVersionId'>;
export type ProductAssessmentId = Branded<'ProductAssessmentId'>;
export type ProfileAssessmentId = Branded<'ProfileAssessmentId'>;
export type AlertPublicationId = Branded<'AlertPublicationId'>;
export type AssessmentCorrectionId = Branded<'AssessmentCorrectionId'>;
export type SafetyReceiptId = Branded<'SafetyReceiptId'>;

/**
 * Idempotency key for a retryable client mutation (`13` "Sync protocol").
 *
 * Client-generated and stable across retries so the server can commit exactly once.
 */
export type OperationId = Branded<'OperationId'>;

/**
 * Unsafe cast used only at trust boundaries where a value has already been validated as a
 * well-formed identifier by a schema (`contracts`) or has been read from a database column
 * whose type is guaranteed by a migration.
 *
 * Deliberately verbose so that grepping for `unsafeId` surfaces every boundary crossing.
 */
export function unsafeId<T extends Branded<string>>(value: string): T {
  return value as T;
}

/** RFC 4122 UUID shape, case-insensitive, any version. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
