/**
 * `@kynviora/presentation` - design tokens, status presentation and safety copy.
 *
 * Platform-neutral and pure. Spec 12 requires critical accessibility behaviour to live in
 * component APIs rather than being reinvented per feature, so the rules that matter - a text
 * label always present, meaning never carried by colour alone, and no forbidden claim - are
 * enforced here and tested here.
 */

export * from './tokens.js';
export * from './status.js';
export * from './copy.js';
export * from './caregiver.js';
export * from './visitPack.js';
export * from './alertDelivery.js';
export * from './reviewInbox.js';
export * from './reconciliation.js';
export * from './screenState.js';
export * from './reviewTaskEditor.js';
export * from './doseEvents.js';
