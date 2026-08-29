import { describe, it, expect } from 'vitest';
import {
  MIN_TOUCH_TARGET_DP,
  MAX_SUPPORTED_FONT_SCALE,
  MIN_BODY_CONTRAST_RATIO,
  MIN_LARGE_TEXT_CONTRAST_RATIO,
  FONT_SIZE,
  LIGHT_THEME,
  contrastRatio,
  relativeLuminance,
  scaledFontSize,
  type ThemeToneToken,
} from './tokens.js';
import {
  presentSafetyState,
  presentEvidenceLevel,
  presentUrgency,
  presentVerification,
  presentMatchConfidence,
  presentCorroboration,
  presentRegulatoryStatus,
  presentApplicability,
  ICON_NAMES,
  type StatusPresentation,
} from './status.js';
import {
  findForbiddenClaims,
  containsForbiddenClaim,
  validateSafetyMessage,
  batchRecallMessage,
  ingredientSensitivityMessage,
  expiryMessage,
  renderSafetyMessage,
  SAFETY_MESSAGE_PARTS,
  GENERIC_NOTIFICATION_BODY,
  coverageDisclosure,
  evidenceAndUrgencySummary,
} from './copy.js';
import {
  ACTION_URGENCIES,
  CATALOG_CORROBORATIONS,
  EVIDENCE_LEVELS,
  ITEM_VERIFICATIONS,
  MATCH_CONFIDENCES,
  PRODUCT_SAFETY_STATES,
  REGULATORY_APPLICABILITIES,
  REGULATORY_STATUSES,
} from '@kynviora/domain';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe('accessibility tokens (spec 18)', () => {
  it('sets a 48dp minimum touch target', () => {
    expect(MIN_TOUCH_TARGET_DP).toBe(48);
  });

  it('uses a body size large enough for the primary audience', () => {
    // Spec 01 and 18 name older adults as a primary audience. A 17sp body reduces how often a
    // user must rely on system scaling to read safety content at all.
    expect(FONT_SIZE.body).toBeGreaterThanOrEqual(16);
  });

  it('supports system font scaling up to 2x', () => {
    expect(MAX_SUPPORTED_FONT_SCALE).toBe(2.0);
    expect(scaledFontSize('body', 2.0)).toBe(FONT_SIZE.body * 2);
  });

  it('never scales below 1x', () => {
    // A system scale below 1 would shrink safety copy. Honouring it would work against the
    // primary audience, so the floor is 1.
    expect(scaledFontSize('body', 0.5)).toBe(FONT_SIZE.body);
  });

  it('clamps above the tested maximum rather than clipping a layout', () => {
    // Spec 18 makes a clipped action in a critical journey a release gate, so scaling stops at
    // the size the layout is tested against instead of growing unbounded.
    expect(scaledFontSize('body', 5.0)).toBe(scaledFontSize('body', MAX_SUPPORTED_FONT_SCALE));
  });
});

describe('colour contrast (spec 18)', () => {
  it('computes known WCAG luminance values', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });

  it('computes the maximum contrast ratio for black on white', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
  });

  it('rejects a malformed colour rather than silently returning a wrong ratio', () => {
    expect(() => relativeLuminance('not-a-colour')).toThrow(TypeError);
    expect(() => relativeLuminance('#FFF')).toThrow(TypeError);
  });

  const tones = Object.keys(LIGHT_THEME) as ThemeToneToken[];

  it.each(tones)('tone %s meets AA body contrast', (tone) => {
    // A semantic tone failing contrast would make safety copy unreadable exactly where it
    // matters most.
    const pair = LIGHT_THEME[tone];
    expect(contrastRatio(pair.background, pair.foreground)).toBeGreaterThanOrEqual(
      MIN_BODY_CONTRAST_RATIO,
    );
  });

  it.each(tones)('tone %s has a border distinguishable from its background', (tone) => {
    // Spec 18 requires the interface to work in high-contrast and greyscale modes, where a
    // surface with no discernible border can disappear entirely.
    const pair = LIGHT_THEME[tone];
    expect(contrastRatio(pair.background, pair.border)).toBeGreaterThan(1.2);
  });

  it('keeps large-text threshold below the body threshold', () => {
    expect(MIN_LARGE_TEXT_CONTRAST_RATIO).toBeLessThan(MIN_BODY_CONTRAST_RATIO);
  });
});

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

/** Every presenter, paired with its full input domain, for exhaustive assertions. */
const allPresentations: readonly { name: string; presentation: StatusPresentation }[] = [
  ...PRODUCT_SAFETY_STATES.map((s) => ({
    name: `safetyState:${s}`,
    presentation: presentSafetyState(s),
  })),
  ...EVIDENCE_LEVELS.map((e) => ({ name: `evidence:${e}`, presentation: presentEvidenceLevel(e) })),
  ...ACTION_URGENCIES.map((u) => ({ name: `urgency:${u}`, presentation: presentUrgency(u) })),
  ...ITEM_VERIFICATIONS.flatMap((v) =>
    (['identity', 'formulation', 'batch'] as const).map((facet) => ({
      name: `verification:${v}:${facet}`,
      presentation: presentVerification(v, facet),
    })),
  ),
  ...MATCH_CONFIDENCES.map((m) => ({
    name: `match:${m}`,
    presentation: presentMatchConfidence(m),
  })),
  ...CATALOG_CORROBORATIONS.map((c) => ({
    name: `corroboration:${c}`,
    presentation: presentCorroboration(c),
  })),
  ...REGULATORY_STATUSES.map((r) => ({
    name: `regulatory:${r}`,
    presentation: presentRegulatoryStatus(r),
  })),
  ...REGULATORY_APPLICABILITIES.map((a) => ({
    name: `applicability:${a}`,
    presentation: presentApplicability(a),
  })),
];

describe('never communicate meaning through colour alone (spec 18)', () => {
  it.each(allPresentations)('$name has a visible text label', ({ presentation }) => {
    expect(presentation.label.trim().length).toBeGreaterThan(0);
  });

  it.each(allPresentations)('$name has a shape-distinguishable icon', ({ presentation }) => {
    expect(ICON_NAMES).toContain(presentation.iconName);
  });

  it.each(allPresentations)('$name has a screen-reader label', ({ presentation }) => {
    expect(presentation.accessibilityLabel.trim().length).toBeGreaterThan(0);
  });

  it.each(allPresentations)('$name has a plain-language description', ({ presentation }) => {
    expect(presentation.description.trim().length).toBeGreaterThan(0);
  });

  it.each(allPresentations)('$name uses no colour word in its label', ({ presentation }) => {
    // A label reading "red" or "green" would reintroduce the colour dependency the icon and
    // text exist to remove, and would be meaningless to a screen-reader user.
    expect(presentation.label.toLowerCase()).not.toMatch(/\b(red|green|amber|yellow|orange)\b/);
    expect(presentation.accessibilityLabel.toLowerCase()).not.toMatch(
      /\b(red|green|amber|yellow|orange)\b/,
    );
  });
});

describe('safety state wording (spec 23 D-005, D-014)', () => {
  it('does not describe the no-alert state as safe', () => {
    // Spec 23 open question: the label must not be misread as "safe".
    const presentation = presentSafetyState('NO_CURRENT_MATCHED_ALERT');
    expect(presentation.label.toLowerCase()).not.toContain('safe');
    expect(presentation.label.toLowerCase()).not.toContain('clear');
    expect(presentation.label.toLowerCase()).not.toContain('ok');
  });

  it('states the limitation of the no-alert state explicitly', () => {
    const presentation = presentSafetyState('NO_CURRENT_MATCHED_ALERT');
    expect(presentation.description).toMatch(/does not mean the product is safe/i);
    expect(presentation.accessibilityLabel).toMatch(/does not mean the product is safe/i);
  });

  it('does not use a positive tone for the no-alert state', () => {
    // A green tick here would communicate exactly what the state does not mean.
    expect(presentSafetyState('NO_CURRENT_MATCHED_ALERT').tone).not.toBe('positive');
  });

  it('offers no safe or unsafe safety state at all', () => {
    for (const { presentation } of allPresentations) {
      expect(presentation.label.toLowerCase()).not.toBe('safe');
      expect(presentation.label.toLowerCase()).not.toBe('unsafe');
    }
  });
});

describe('evidence and urgency are presented independently (spec 23 D-005)', () => {
  it('uses disjoint label vocabularies', () => {
    const evidenceLabels = EVIDENCE_LEVELS.map((e) => presentEvidenceLevel(e).label);
    const urgencyLabels = ACTION_URGENCIES.map((u) => presentUrgency(u).label);
    const overlap = evidenceLabels.filter((l) => urgencyLabels.includes(l));
    expect(overlap).toEqual([]);
  });

  it('does not give strong evidence an alarming tone', () => {
    // Evidence strength describes the source, not how urgently to act. Rendering official-action
    // evidence in an alarm tone would conflate the two dimensions.
    expect(presentEvidenceLevel('A').tone).not.toBe('action');
  });

  it('summarises them as two separate strings, never concatenated', () => {
    const summary = evidenceAndUrgencySummary('A', 'CRITICAL');
    expect(summary.evidence).toBe('Official action');
    expect(summary.urgency).toBe('Time-sensitive');
    expect(Object.keys(summary).sort()).toEqual(['evidence', 'urgency']);
  });

  it('exports no function combining them into one value', async () => {
    const module = await import('./index.js');
    for (const forbidden of ['severityFor', 'combinedSeverity', 'safetyScore', 'toSeverity']) {
      expect(Object.keys(module)).not.toContain(forbidden);
    }
  });
});

describe('regulatory status wording (spec 09, 24)', () => {
  it('presents RESTRICTED as allowed with conditions, never banned', () => {
    const presentation = presentRegulatoryStatus('RESTRICTED');
    expect(presentation.label).toBe('Allowed with conditions');
    expect(presentation.label.toLowerCase()).not.toContain('ban');
    expect(presentation.accessibilityLabel).toMatch(/not banned/i);
  });

  it('presents a concentration limit without implying a violation', () => {
    const presentation = presentRegulatoryStatus('CONCENTRATION_LIMIT');
    expect(presentation.description.toLowerCase()).not.toMatch(/exceed|violat|illegal/);
  });

  it('presents no-matched-rule as a finding, not approval', () => {
    const presentation = presentRegulatoryStatus('NO_MATCHED_RULE_WITHIN_COVERAGE');
    expect(presentation.label).toBe('No rule found');
    expect(presentation.label.toLowerCase()).not.toContain('approv');
    expect(presentation.label.toLowerCase()).not.toContain('permitted');
    expect(presentation.description).toMatch(/not approval/i);
    expect(presentation.tone).not.toBe('positive');
  });

  it('labels a scientific opinion as not law', () => {
    const presentation = presentRegulatoryStatus('SCIENTIFIC_OPINION');
    expect(presentation.label).toMatch(/not law/i);
    expect(presentation.tone).not.toBe('action');
  });

  it('presents CONDITION_UNKNOWN as an inability to tell, not a verdict', () => {
    const presentation = presentApplicability('CONDITION_UNKNOWN');
    expect(presentation.label).toMatch(/cannot tell/i);
    expect(presentation.description.toLowerCase()).not.toMatch(/exceed|violat|complian/);
  });
});

describe('verification facets stay distinct (spec 18)', () => {
  it('names the facet in every label', () => {
    expect(presentVerification('CONFIRMED', 'identity').label).toBe('Product confirmed');
    expect(presentVerification('CONFIRMED', 'formulation').label).toBe('Formula confirmed');
    expect(presentVerification('CONFIRMED', 'batch').label).toBe('Batch confirmed');
  });

  it('uses the specific wording spec 18 gives for an unentered batch', () => {
    expect(presentVerification('UNVERIFIED', 'batch').label).toBe('Batch not entered');
  });

  it('produces different labels for the same state across facets', () => {
    const labels = (['identity', 'formulation', 'batch'] as const).map(
      (facet) => presentVerification('UNVERIFIED', facet).label,
    );
    expect(new Set(labels).size).toBe(3);
  });
});

describe('corroboration wording (spec 08)', () => {
  it('says corroboration is about the label, not safety', () => {
    const presentation = presentCorroboration('CORROBORATED');
    expect(presentation.description).toMatch(/not about safety/i);
  });

  it('shows no percentage or certainty score', () => {
    // Spec 08 forbids "a fake mathematical certainty score simply because many users submitted
    // the same record", and spec 18 forbids uncalibrated percentages.
    for (const state of CATALOG_CORROBORATIONS) {
      const presentation = presentCorroboration(state);
      expect(presentation.label).not.toMatch(/\d+\s*%/);
      expect(presentation.description).not.toMatch(/\d+\s*%/);
    }
  });
});

// ---------------------------------------------------------------------------
// Forbidden claims
// ---------------------------------------------------------------------------

describe('forbidden claim detection (spec 18, 02, 09)', () => {
  const forbidden: readonly [string, string][] = [
    ['This product is safe.', 'no-safety-guarantee'],
    ['The medicine is dangerous.', 'no-danger-claim'],
    ['AI detected a harmful ingredient.', 'no-ai-attribution'],
    ['Our model determined this is a match.', 'no-ai-attribution'],
    ['Stop taking this medicine now.', 'no-stop-medicine-instruction'],
    ['You should start a new medication.', 'no-start-medicine-instruction'],
    ['Halve your dose until you feel better.', 'no-dose-change-instruction'],
    ['Switch to another brand instead.', 'no-substitution-advice'],
    ['This ingredient is approved by the FDA.', 'no-approval-from-absence'],
    ['A chemical-free formulation.', 'no-natural-equals-safe'],
    ['The EU has stricter regulations than the US.', 'no-jurisdiction-ranking'],
    ['You forgot to take it again.', 'no-shaming'],
    ['You may have a condition related to this.', 'no-diagnosis'],
  ];

  it.each(forbidden)('flags %s', (text, rule) => {
    const claims = findForbiddenClaims(text);
    expect(claims.map((c) => c.rule)).toContain(rule);
  });

  it.each(forbidden)('explains why %s is forbidden', (text) => {
    for (const claim of findForbiddenClaims(text)) {
      expect(claim.reason.length).toBeGreaterThan(20);
      expect(claim.reason).toMatch(/spec/i);
    }
  });

  const permitted: readonly string[] = [
    // Every one of these is copy the spec explicitly requires or endorses. A detector that
    // flagged them would make the mandated limitation wording unwritable.
    'This does not mean the product is safe for everyone.',
    'No current matched alert was found in Kynviora’s monitored sources. This does not guarantee the product is safe for everyone.',
    'This batch matches the batch listed in the official notice.',
    'Your product label contains an ingredient that matches a sensitivity recorded for Priya.',
    'Kynviora could not verify the current formula. Check the ingredient label before relying on this result.',
    'Restricted in EU cosmetics under specified conditions.',
    'No matched federal prohibition found in Kynviora’s monitored US cosmetic-ingredient sources. This is not FDA approval or a guarantee of safety.',
    'Speak to your pharmacist or doctor before changing anything.',
    'Contact the pharmacy or supplier you bought it from.',
    'An ingredient being present does not mean a reaction will happen.',
  ];

  it.each(permitted)('does not flag required copy: %s', (text) => {
    expect(findForbiddenClaims(text)).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(containsForbiddenClaim('THIS PRODUCT IS SAFE')).toBe(true);
  });

  it('suppresses the safety rule when negated, because the spec requires that wording', () => {
    // "This does not mean the product is safe for everyone" is copy spec 09 and 18 explicitly
    // require. A detector that flagged it would make the mandated limitation unwritable.
    expect(containsForbiddenClaim('This does not mean the product is safe for everyone.')).toBe(
      false,
    );
    expect(containsForbiddenClaim('Kynviora cannot say the product is safe.')).toBe(false);
  });

  it('still flags a negated danger claim, because that is a safety verdict too', () => {
    // Deliberate asymmetry: "this product is not dangerous" asserts safety, which spec 23 D-005
    // forbids just as firmly as the positive form.
    expect(containsForbiddenClaim('This product is not dangerous.')).toBe(true);
  });

  it('reports every violation, not just the first', () => {
    const claims = findForbiddenClaims('This product is safe. AI detected no problems.');
    expect(claims.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Safety message templates
// ---------------------------------------------------------------------------

describe('safety message structure (spec 18)', () => {
  const batchRecall = batchRecallMessage({
    personName: 'Priya',
    itemName: 'Synthetic Serum',
    matchConfidence: 'EXACT',
    authority: 'CDSCO (synthetic fixture)',
    jurisdictionName: 'India',
    publicationDate: '2026-08-15',
    lotCode: 'SYN-BATCH-A24X91',
  });

  const sensitivity = ingredientSensitivityMessage({
    personName: 'Priya',
    itemName: 'Synthetic Serum',
    ingredientName: 'salicylic acid',
    recordedTerm: 'salicylates',
    formulationConfirmedFromLabel: true,
  });

  const expiry = expiryMessage({
    personName: 'Priya',
    itemName: 'Synthetic Tablet',
    expiresOn: '2026-01-01',
    hasExpired: true,
  });

  const messages = [
    ['batchRecall', batchRecall],
    ['ingredientSensitivity', sensitivity],
    ['expiry', expiry],
  ] as const;

  it('defines the eight parts in the prescribed order', () => {
    expect([...SAFETY_MESSAGE_PARTS]).toEqual([
      'whatHappened',
      'whoAndWhat',
      'matchExactness',
      'recommendedNextStep',
      'whyFlagged',
      'evidenceAndSource',
      'limitation',
      'correctionAction',
    ]);
  });

  it.each(messages)('%s fills every part', (_name, message) => {
    for (const part of SAFETY_MESSAGE_PARTS) {
      expect(message[part].trim().length).toBeGreaterThan(0);
    }
  });

  it.each(messages)('%s contains no forbidden claim', (_name, message) => {
    // The point of this test: forbidden phrasing cannot reach a user through a template that
    // nobody happened to re-read.
    expect(validateSafetyMessage(message)).toEqual([]);
  });

  it.each(messages)('%s renders in order', (_name, message) => {
    const rendered = renderSafetyMessage(message);
    expect(rendered).toHaveLength(8);
    expect(rendered[0]).toBe(message.whatHappened);
    expect(rendered[6]).toBe(message.limitation);
  });

  it('names the person and the exact item', () => {
    // Spec 07.3 requires the affected person and exact item in every alert.
    expect(batchRecall.whoAndWhat).toContain('Priya');
    expect(batchRecall.whoAndWhat).toContain('Synthetic Serum');
  });

  it('routes a medicine action to a professional rather than instructing a change', () => {
    // Spec 09: never tell a user to stop a prescription medicine. The bounded action is to ask
    // the pharmacy or supplier.
    expect(batchRecall.recommendedNextStep).toMatch(/pharmacist|doctor|pharmacy|supplier/i);
    expect(findForbiddenClaims(batchRecall.recommendedNextStep)).toEqual([]);
  });

  it('states a batch limitation when the match is only probable', () => {
    const probable = batchRecallMessage({
      personName: 'Priya',
      itemName: 'Synthetic Serum',
      matchConfidence: 'PROBABLE',
      authority: 'CDSCO (synthetic fixture)',
      jurisdictionName: 'India',
      publicationDate: '2026-08-15',
      lotCode: null,
    });
    expect(probable.matchExactness).toMatch(/has not recorded a batch number/i);
    expect(probable.limitation).toMatch(/may not be affected/i);
  });

  it('does not generalise a sensitivity match to the whole brand', () => {
    // Spec 09: do not generalise into "this brand is dangerous" or "unsafe for everyone".
    expect(sensitivity.limitation).toMatch(/does not mean a reaction will happen/i);
    expect(sensitivity.limitation).toMatch(/not a diagnosis/i);
    expect(sensitivity.whatHappened).toContain('salicylic acid');
  });

  it('flags an unconfirmed formulation in the sensitivity message', () => {
    const unconfirmed = ingredientSensitivityMessage({
      personName: 'Priya',
      itemName: 'Synthetic Serum',
      ingredientName: 'salicylic acid',
      recordedTerm: 'salicylates',
      formulationConfirmedFromLabel: false,
    });
    expect(unconfirmed.matchExactness).toMatch(/not been confirmed/i);
  });
});

describe('notification and coverage copy', () => {
  it('uses a generic lock-screen body revealing nothing', () => {
    // Spec 15 A6: a notification must not leak a medicine or condition to a lock screen.
    expect(GENERIC_NOTIFICATION_BODY).toBe('Kynviora has an important update.');
    expect(GENERIC_NOTIFICATION_BODY.toLowerCase()).not.toMatch(
      /medicine|medication|recall|allerg|ingredient|batch/,
    );
  });

  it('states what coverage does and does not include', () => {
    const disclosure = coverageDisclosure(['India', 'European Union']);
    expect(disclosure).toContain('India');
    expect(disclosure).toMatch(/does not cover every source/i);
    expect(disclosure).toMatch(/not a guarantee of safety/i);
  });

  it('is explicit when nothing is monitored', () => {
    expect(coverageDisclosure([])).toMatch(/not currently monitoring/i);
  });

  it('contains no forbidden claim', () => {
    expect(findForbiddenClaims(coverageDisclosure(['India']))).toEqual([]);
    expect(findForbiddenClaims(GENERIC_NOTIFICATION_BODY)).toEqual([]);
  });
});

describe('every shipped presentation string is checked for forbidden claims', () => {
  it.each(allPresentations)('$name uses permitted wording', ({ presentation }) => {
    // The broadest guarantee in this file: no status a user can see anywhere in the product
    // carries phrasing the spec forbids.
    expect(findForbiddenClaims(presentation.label)).toEqual([]);
    expect(findForbiddenClaims(presentation.description)).toEqual([]);
    expect(findForbiddenClaims(presentation.accessibilityLabel)).toEqual([]);
  });
});
