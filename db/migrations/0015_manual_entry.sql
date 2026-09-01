-- 0015_manual_entry.sql
-- What a person can write down about a pack they are holding (spec 04 Phases 2.2 and 2.3).
--
-- Spec references: 04 Phase 2.2 (brand/generic name; strength and dosage form;
-- manufacturer/marketer and market; product identifiers/barcode if available; batch/lot, expiry
-- and pack evidence; source/provenance and confidence - with the exit criteria "a user can create
-- a clinically useful current medicine record entirely manually" and "missing fields remain
-- explicitly unknown rather than receiving defaults"), 04 Phase 2.3 (brand/product/category;
-- manufacturer/marketer and market; barcode/product identifier; formulation/label version state;
-- ingredient declaration text plus normalized ingredients when available; batch/lot/expiry where
-- printed - with the exit criteria "product detail makes identity versus formula confidence
-- visible" and "personal-care data is not reduced to name + barcode"), 07, 08, 15 A11.
--
-- WHY THESE COLUMNS ARE ON owned_item AND NOT IN THE CATALOG
-- The catalog already has all of them. marketed_formulation holds ingredient_declaration_raw and
-- product_identity holds a gtin, and neither is the household's to write: the catalog is shared
-- across every user and threat A11 is a hostile record poisoning it. Spec 07 draws the line
-- already - a user's own record is "distinct from the shared catalog observation so changing
-- shared catalog knowledge does not silently change what package the user actually recorded" -
-- and these columns are the other side of it. What somebody transcribed off their own pack stays
-- on their own row, is visible to nobody else, and corroborates nothing.
--
-- Promotion to the catalog is a separate, corroborated path (spec 04 Phase 3.5), and it must stay
-- separate. A manual entry that wrote a candidate formulation would be exactly A11 with the
-- attacker replaced by an honest person mis-reading a label.
--
-- EVERY COLUMN IS NULLABLE, AND THAT IS THE SECOND EXIT CRITERION
-- "Missing fields remain explicitly unknown rather than receiving defaults." None of these has a
-- DEFAULT clause and none is NOT NULL, so an absent value is stored as an absence. The three
-- verification columns added in 0004 already default to UNVERIFIED, which is not a default answer
-- but the vocabulary's own word for "nobody has checked".

ALTER TABLE owned_item
  -- Who made or markets it, as the person read it off the pack. Free text: a manufacturer name
  -- normalized against a list Kynviora does not have would be a claim nobody made.
  ADD COLUMN manufacturer text,
  -- The barcode as recorded here, separate from product_identity.gtin. A household typing a
  -- number is not the catalog learning one, and 08 keeps identity resolution to the catalog.
  ADD COLUMN recorded_gtin text,
  -- The batch or lot code as printed, separate from batch_or_lot.lot_code. Recording it here does
  -- not create a catalog batch, because a batch nobody else has seen is not a shared fact.
  ADD COLUMN recorded_lot_code text,
  -- The ingredient declaration exactly as printed on the pack this household holds. Spec 05.1:
  -- raw label evidence is never overwritten by normalization, and this is never normalized at all
  -- - normalization belongs to the catalog path, which this deliberately does not enter.
  ADD COLUMN ingredient_declaration_raw text,
  -- Which label version the pack appears to be, in the person's own words. Free text because a
  -- structured version needs a catalog record to be a version *of*.
  ADD COLUMN label_version_note text;

ALTER TABLE owned_item
  -- The same shape product_identity.gtin requires. A barcode of the wrong length is a typing
  -- mistake, and storing it would make a recall check silently miss the pack it was about.
  ADD CONSTRAINT owned_item_recorded_gtin_shape CHECK (
    recorded_gtin IS NULL
    OR recorded_gtin ~ '^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$'
  ),
  -- Blank is not a value. A row of spaces would be an answer the screen renders as one, where an
  -- absence renders as "not recorded" - and only the second is true.
  ADD CONSTRAINT owned_item_manual_text_not_blank CHECK (
    (manufacturer IS NULL OR length(btrim(manufacturer)) > 0)
    AND (recorded_lot_code IS NULL OR length(btrim(recorded_lot_code)) > 0)
    AND (ingredient_declaration_raw IS NULL OR length(btrim(ingredient_declaration_raw)) > 0)
    AND (label_version_note IS NULL OR length(btrim(label_version_note)) > 0)
  );

COMMENT ON COLUMN owned_item.recorded_gtin IS
  'The barcode as this household recorded it. Never promoted to product_identity: a household '
  'typing a number is not the catalog learning one (threat A11, spec 04 Phase 3.5).';

COMMENT ON COLUMN owned_item.ingredient_declaration_raw IS
  'The declaration as printed on the pack this household holds, never normalized and never '
  'shared. The catalog copy is marketed_formulation.ingredient_declaration_raw and is a '
  'different fact about a different object (spec 07).';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Nothing to add. These are columns on owned_item, and 0004's policies already decide who may
-- read and write it: VIEW_SHELF / MANAGE_SHELF for personal care, VIEW_MEDICINES /
-- MANAGE_MEDICINES for a medicine. A separate table would have needed its own policy and would
-- have been a second place where shelf access is decided, which is the thing 0004 avoided.
