/**
 * What time it is where somebody is (`04` Phase 7.5, DEC-119, `DEV-030`).
 *
 * Spec references: `04` Phase 7.5 (quiet hours), `04` Phase 4.1 (time-zone handling: a local wall
 * clock plus a zone, never a stored offset), `18` (a rule whose meaning depends on the reader has
 * no place deciding whether somebody is woken up), DEC-003 (time is supplied, never read).
 *
 * WHY A ZONE AND NOT AN OFFSET
 * An offset is a number that is wrong twice a year. `Asia/Kolkata` is a fact about a place;
 * `+05:30` is a fact about a place *and a date*, and storing the second is storing the answer to a
 * question that will be asked again later under different circumstances. `04` Phase 4.1 already
 * decided this for schedules - `times_local` plus `timezone` - and this is the same decision for
 * the same reason, arriving at the other end of the system.
 *
 * WHY THE CONVERSION IS `Intl` RATHER THAN ARITHMETIC
 * Because the arithmetic is a zone database, and writing one is how a product ends up holding a
 * critical alert for an hour on the last Sunday in October. `Intl.DateTimeFormat` is backed by ICU,
 * which Node has built in, and it knows every transition this needs to get right.
 *
 * THE ONE RULE
 * **An unknown zone is not a zone.** Every function here answers `null` rather than guessing, and
 * `deliveryDecision` reads `null` as "do not hold" - so a person whose zone Kynviora does not know
 * gets their notification rather than an indefinite silence. That is the biased direction and it is
 * the right bias: the failure it avoids is a `CRITICAL` recall waiting for a window that never
 * ends, and the failure it accepts is a phone lighting up at an hour somebody would rather it had
 * not.
 */

/**
 * An offset written where a zone belongs: `+05:30`, `-0800`, `+07`.
 *
 * Modern ICU **accepts these** as a `timeZone`, which is a genuine surprise and exactly the thing
 * this module exists to refuse. `Intl.DateTimeFormat` will happily format against `+05:30`, and a
 * value stored that way is a fact about a place *and a date* masquerading as a fact about a place -
 * correct today, an hour wrong after the next transition, and what it decides is whether somebody
 * is woken at three in the morning.
 *
 * So the refusal is explicit rather than inherited from the platform, because the platform does
 * not refuse it.
 */
const OFFSET_SHAPED = /^[+-]\d{1,2}(:?\d{2})?$/;

/**
 * Whether a string names a time zone this runtime knows.
 *
 * Asked by constructing a formatter and catching, which is the only way to ask: there is no list
 * to check against, and a hand-written pattern would accept `Foo/Bar` and reject `UTC`.
 *
 * An offset is refused first. See {@link OFFSET_SHAPED} - ICU would accept it.
 */
export function isKnownTimeZone(zone: string): boolean {
  const trimmed = zone.trim();
  if (trimmed === '') return false;
  if (OFFSET_SHAPED.test(trimmed)) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Narrow a stored or reported zone, or `null`.
 *
 * The place a value from outside becomes one this system will act on. A device reports whatever
 * its platform says, a database holds whatever was written years ago, and a runtime knows whatever
 * ICU version it was built with - so the answer has to be asked of *this* runtime rather than
 * assumed from the shape of the string.
 */
export function asTimeZone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const zone = value.trim();
  return isKnownTimeZone(zone) ? zone : null;
}

/**
 * The minute of the local day, in `zone`, at `instant`.
 *
 * `null` for a zone this runtime does not know or an instant it cannot read - and `null` is a
 * meaningful answer here rather than a failure, because it is what "do not hold" is expressed as.
 *
 * The hour is read with `hourCycle: 'h23'` rather than `hour12: false`, which is not a style
 * choice: `hour12: false` produces `24` for midnight in several locales, and a quiet-hours window
 * evaluated at minute 1440 is one that silently stops matching at exactly the hour it matters most.
 */
export function localMinuteOfDayIn(instant: string, zone: string): number | null {
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return null;
  if (!isKnownTimeZone(zone)) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(at));

    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    return hour * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * The recipient's local minute, or `null` where it cannot be established.
 *
 * The one function a dispatcher calls, so the "unknown means do not hold" rule is applied in one
 * place rather than by each caller remembering it. A caller that had to check the zone itself is a
 * caller that can forget to, and forgetting means either inventing a local time or holding a
 * critical alert - both of which this exists to prevent.
 */
export function recipientLocalMinute(input: {
  readonly at: string;
  readonly zone: unknown;
}): number | null {
  const zone = asTimeZone(input.zone);
  return zone === null ? null : localMinuteOfDayIn(input.at, zone);
}
