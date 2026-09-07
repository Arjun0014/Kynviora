/**
 * Resolving a table whose key came from outside this repository.
 *
 * Spec references: DEC-146, `DEV-081`, `17` (a model completion is untrusted input, of the same
 * class as an uploaded package or a regulatory PDF), `13` (a client's string is not a type).
 *
 * WHY THIS EXISTS RATHER THAN AN INDEX AND A `??`
 * `Object.freeze` does not remove a prototype. A frozen object literal used as a lookup table
 * still answers to every name on `Object.prototype`, so `TABLE['toString']` is not `undefined` -
 * it is `Object.prototype.toString`, and `String()` of it is
 * `"function toString() { [native code] }"`. The same is true of `constructor`, `valueOf`,
 * `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString` and `__proto__`.
 *
 * That matters because of what `??` is doing at those call sites. In this codebase a lookup that
 * falls back is almost always encoding a **decision about absence**, and the decision is usually
 * to say nothing:
 *
 *   - `describeUnresolvedCondition` returns `null` so the Lens **drops** a condition it has no
 *     approved sentence for, because a generic one "reads as a complete answer when it is not".
 *   - `presentProvenance` returns `null` rather than the raw code beside somebody's allergy.
 *   - `summariseProposal` falls back to "what happened" rather than naming an event kind the
 *     record does not carry.
 *
 * An inherited property defeats every one of those, because it is neither `null` nor `undefined`.
 * The fallback does not fire, the value is a **function**, and it is rendered or spoken. So the
 * absence a screen was carefully designed to state honestly is replaced by machine noise, on the
 * screens where `09` and `18` are most demanding about precision.
 *
 * `DEV-081` was this exact defect in the Speech Gate, and DEC-146 is the general rule it produced:
 * **any lookup whose key comes from outside this repository must resolve as an own property.**
 * This function is that rule, written once, so the next table does not have to rediscover it.
 *
 * WHAT THIS IS NOT FOR
 * A lookup whose key is a narrowed union the caller has already validated - `presentCertainty`
 * taking a `FactCertainty` after `isFactCertainty` - does not need this, and wrapping those would
 * be churn that adds no safety. The distinguishing property is an **open `string` key**, where the
 * fallback is load-bearing because the caller genuinely does not know whether the key is one of
 * the table's.
 */

/**
 * The value stored at `key`, or `null` where the table does not itself carry that name.
 *
 * `Object.hasOwn` is the whole mechanism: an inherited name is not an own property, so it answers
 * `false` and the caller's absence branch runs as it was designed to. The `typeof` check is the
 * second half rather than belt and braces - a table could legitimately hold a non-string value,
 * and a caller asking for a string wants the absence branch rather than whatever else is there.
 */
export function ownEntry<TValue>(
  table: Readonly<Record<string, TValue>>,
  key: string,
): TValue | null {
  if (!Object.hasOwn(table, key)) return null;
  const value: unknown = (table as Record<string, unknown>)[key];
  return (value ?? null) === null ? null : (value as TValue);
}

/**
 * Whether `key` is one the table itself carries.
 *
 * For the callers that need to narrow a string rather than read a value - the shape
 * `isUtteranceKey` has in `packages/agent/src/speech.ts`, which is where this rule was first
 * written down.
 */
export function isOwnKey<TValue>(table: Readonly<Record<string, TValue>>, key: string): boolean {
  return Object.hasOwn(table, key);
}
