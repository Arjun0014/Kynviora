# Product Vision

Status: Source of truth for product direction
Last reviewed: 2026-08-29

## One-sentence vision

Kynviora is a family safety layer for medicines and personal-care products: it knows what a
person actually uses, monitors trusted changes around those exact items, explains personal
relevance with visible uncertainty, and helps the user or caregiver take the next safe step.

## The problem

People do not experience health and product safety as separate databases. A parent may use
several medicines, a supplement, a skin cream, shampoo, toothpaste, sunscreen, and other
products every day. The useful information is fragmented across packaging, prescriptions,
messages, regulatory notices, pharmacy advice, product databases, research, and memory.

The real problem is not merely remembering an item. It is maintaining an accurate current
picture and knowing when something meaningful changes.

Examples:

- A medicine batch is recalled, but the family does not know whether their exact pack is affected.
- A product formula changes between countries or over time while the barcode appears familiar.
- A user with a recorded allergy starts a personal-care item with a relevant ingredient.
- A caregiver knows a product name but not the exact strength, variant, lot, or last review date.
- A safety headline creates fear without explaining evidence quality or personal applicability.
- An ingredient may be permitted, restricted, concentration-limited, or prohibited differently across India, the EU, Great Britain, Northern Ireland, the United States, or Japan, but users rarely have a trustworthy way to see the exact legal difference.
- A doctor visit starts with an incomplete medicine list and no record of what changed recently.

## Primary users

### Older adult using Kynviora directly

Needs large readable controls, low typing burden, dependable reminders, clear explanations,
and confidence that the app will not panic them with weak evidence.

### Family caregiver

Needs a reliable, permissioned view of a relative's medicines, personal-care products,
appointments, unresolved safety items, and review tasks without becoming an invisible owner
of the relative's account.

### Adult managing their own medicines and sensitivities

Needs a current shelf, product verification, reminders, evidence-aware alerts, and a way to
prepare for professional conversations.

## Long-term product promise

Kynviora should be able to answer five questions for any supported item:

1. What exactly is this item?
2. How sure are we about its identity, formulation, batch, and current use?
3. Is there a reviewed reason this person should pay attention to it now?
4. What changed, how strong is the evidence, and what are the limitations?
5. How do supported regulators treat the same product/ingredient, and is the difference a prohibition, restriction, condition, product action, or scientific opinion?
6. What is the safest reasonable next action within Kynviora's allowed role?

## What makes the vision valuable

The product is not trying to own every medical decision. Its value comes from continuously
maintaining the connection between four things that are usually separated:

- the person;
- the exact item they use;
- the evidence and official actions that apply to that item;
- the jurisdiction-specific regulatory treatment of the same ingredient/product;
- the family's care workflow after something changes.

## MVP vision

The MVP must demonstrate the vision, not merely a thin utility app. It therefore includes
both medicines and personal-care products as real, usable domains.

A strong MVP demonstration should show:

- a medicine added and verified;
- a previously unseen personal-care product captured from its package and added to the Living Catalog;
- the same product recognized from the catalog on a later lookup;
- a changed formulation detected without overwriting the older formula;
- different identity confidence for each item;
- recorded health context relevant to allowed safety checks;
- a narrow set of reviewed safety checks;
- an official or simulated reviewed safety update matched to the correct item;
- a Global Regulatory Lens showing materially different jurisdictional treatment with official-source provenance and clear limitations;
- a clear explanation of evidence, match confidence, and next action;
- an authorized caregiver receiving only permitted information;
- a doctor/pharmacist-ready summary that shows current items and unresolved issues.

## Living Catalog and global regulatory direction

Kynviora does not need a complete commercial product database before launch. The product catalog may begin sparse and become more useful through verified observations, but the system must start with seeded normalization vocabularies, approved regulatory sources, and reviewed safety rules.

A newly observed package can create a candidate commercial identity and formulation only after the capture pipeline preserves the original evidence, validates extracted fields, and requires confirmation where confidence is insufficient. Repeated independent package observations may corroborate a formulation; they do not establish medical safety.

The Global Regulatory Lens is part of the product vision, not a claim that one jurisdiction is "stricter" or that foreign regulation automatically applies locally. Kynviora should show the exact status and scope in each supported jurisdiction, such as prohibited, restricted, concentration-limited, use-limited, warning-required, recalled/withdrawn, under scientific review, no matched rule found, or unknown. A foreign regulatory difference is normally informational unless a separately reviewed Kynviora rule establishes personal safety relevance.

## Product boundaries

Kynviora does not autonomously:

- diagnose a condition;
- interpret a symptom as proof that a product caused it;
- prescribe treatment;
- tell a user to stop, start, split, replace, or change a prescription medicine;
- turn a research headline into a safety warning;
- claim that no alert means a product is guaranteed safe;
- use generative AI as the authority for severity or clinical conclusions;
- rank sponsored products above safety considerations.

## Long-term expansion path

The product should expand by strengthening the same core loop rather than by adding unrelated
features.

### Identity expansion

Medicines and personal care -> supplements -> selected household products -> devices where
source quality and relevance justify support.

### Evidence expansion

Official recalls and label actions -> narrow reviewed rules -> broader interaction/reference
knowledge -> reviewed evidence monitoring with human governance.

### Care expansion

Personal use -> caregiver collaboration -> medicine reconciliation -> clinician/pharmacist
handoff -> selected institutional partnerships.

### Regional expansion

India-first operational depth -> additional jurisdictions through explicit source adapters,
coverage statements, legal review, localization, and local clinical governance.

## The product should feel

- calm, not alarming;
- precise, not magical;
- supportive, not paternalistic;
- transparent about uncertainty;
- useful even when the answer is "we do not know yet";
- safer because it asks for confirmation rather than pretending to be certain.

## North-star experience

A user should be able to open an item and immediately understand:

- what Kynviora thinks the item is;
- how confident that identification is;
- who uses it;
- what Kynviora currently knows and monitors;
- whether anything changed;
- when it was last checked;
- what evidence supports the current status;
- what the user should do next, if anything.

That experience is the heart of Kynviora.
