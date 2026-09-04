/**
 * Prove - or fail to prove - that somebody can write a personal-care product down on a phone, and
 * that what they wrote is what Kynviora keeps.
 *
 * Spec references: `19` ("personal-care add/scan/OCR/confirm path"), `04` Phase 2.3 (manual
 * personal-care entry), `10`, `02`, `09`, `BLK-007`, `DEV-040`.
 *
 *   npm run verify:device:personalcare
 *
 * WHAT THIS RUN CLAIMS, AND WHAT IT REFUSES TO CLAIM
 * `19` names four things in one line - add, scan, OCR, confirm - and two of them do not exist in
 * this build. There is no barcode scanner and no extraction provider is credentialed (`BLK-007`),
 * so the run drives the manual path and says so in its own report rather than letting a green
 * result stand in for a scenario it did not exercise.
 *
 * WHAT IS ACTUALLY DONE TO THE DEVICE
 * The Shelf tab is opened, "Add a personal-care product" is tapped, a name is typed, a category is
 * chosen, an ingredient declaration is typed, and the form is saved. Nothing is written into the
 * app by this script: the product is created by the app's own code path, and the API is read from
 * the host only to see what arrived.
 *
 * The barcode, the batch code and the expiry date are deliberately left blank, and the declaration
 * deliberately filled in. That asymmetry is `PC-4`: three limits have to be stated afterwards and
 * the fourth must not be, which is the only shape of check that can tell a screen reading the
 * record apart from one printing the same four sentences every time.
 *
 * WHAT IT LEAVES BEHIND
 * One personal-care item on the development household's shelf, permanently - items are archived
 * rather than deleted and the app role is granted no delete. The name carries this run's own
 * suffix so runs can be told apart, which is also what makes `PC-0` answerable. It belongs on the
 * synthetic seed and nowhere near a shelf somebody uses.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import {
  LIMITS_OF_BLANK_FIELDS,
  LIMIT_OF_NO_DECLARATION,
  limitsStatedCheck,
  notConfirmedCheck,
  personalCareCreatedCheck,
  personalCareFormCheck,
  shelfPreconditionCheck,
  storedFieldsCheck,
  type DetailField,
  type IntendedEntry,
  type ServerItem,
} from './personalCareEntry.js';
import {
  captureFailure,
  coldStart,
  collectScreenText,
  isSelected,
  prepareDeviceForDriving,
  scrollToAndTap,
  scrollToAndTapBelow,
  tapNamed,
  typeInto,
} from './ui.js';

const API_PORT = 3000;
const USER_ID = '00000000-0000-4000-8000-00000000d001';
const PROFILE_ID = '00000000-0000-4000-8000-00000000d020';

/** The suffix keeps runs apart, because items are archived rather than deleted. */
const SUFFIX = Date.now().toString(36).slice(-4).toUpperCase();

const INTENDED: IntendedEntry = {
  displayName: `Synthetic Lotion ${SUFFIX}`,
  categoryLabel: 'Skin care',
  categoryValue: 'SKIN_CARE',
  // An INCI list as it is printed: upper case, in order, comma separated. Typed exactly like this
  // and compared exactly like this, because a list the app tidied is a different list (`09`).
  ingredientDeclaration: 'AQUA, GLYCERIN, PARFUM',
};

async function apiFetch(path: string): Promise<Response | null> {
  // The retry the other device harnesses need, for the same reason: `sleep` blocks the event loop
  // for most of a run, so a pooled connection is dead by the time the next call uses it (trap 188).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(`http://127.0.0.1:${String(API_PORT)}${path}`, {
        headers: { 'x-kynviora-dev-user': USER_ID, connection: 'close' },
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

/** `null` where the shelf could not be read, which is not the same as "there is nothing on it". */
async function shelfItems(): Promise<readonly ServerItem[] | null> {
  const response = await apiFetch(`/v1/items?profileId=${encodeURIComponent(PROFILE_ID)}`);
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as { readonly items?: readonly ServerItem[] };
  return body.items ?? null;
}

/** The category fields on an item's detail, as the API renders them for a screen. */
async function categoryFields(itemId: string): Promise<readonly DetailField[] | null> {
  const response = await apiFetch(`/v1/items/${encodeURIComponent(itemId)}`);
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as { readonly categoryFields?: readonly DetailField[] };
  return body.categoryFields ?? null;
}

async function main(): Promise<void> {
  if (!isInstalled()) {
    process.stdout.write(
      `${PACKAGE} is not installed on the attached device.\n` +
        '  cd apps/mobile && npx expo run:android\n',
    );
    process.exitCode = 1;
    return;
  }

  const before = await shelfItems();
  if (before === null) {
    process.stdout.write(
      `No seeded API on 127.0.0.1:${String(API_PORT)}. This scenario creates a product through\n` +
        'the real route, so there has to be one:\n' +
        '  KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev\n',
    );
    process.exitCode = 1;
    return;
  }

  const checks: Check[] = [];
  checks.push(shelfPreconditionCheck({ before, intended: INTENDED }));

  prepareDeviceForDriving();
  const ready = coldStart('personalcare');

  process.stdout.write(`Adding ${INTENDED.displayName}...\n`);
  const steps: (readonly [string, boolean])[] = [['launch the app', ready]];
  const step = (what: string, run: () => boolean): boolean => {
    const happened = run();
    steps.push([what, happened]);
    if (!happened) captureFailure(`personalcare-${what.replace(/[^a-z]+/gi, '-')}`);
    return happened;
  };

  let nameHeld: string | null = null;
  let declarationHeld: string | null = null;
  let categoryChosen: boolean | null = null;
  let limitsScreen: readonly string[] | null = null;

  if (
    ready &&
    step('open the Shelf tab', () => tapNamed('Shelf')) &&
    step('open the personal-care form', () => scrollToAndTap('Add a personal-care product'))
  ) {
    sleep(3_000);
    const name = typeInto('What is it called', INTENDED.displayName);
    nameHeld = name.held;
    steps.push(['type the name', name.typed]);

    if (name.typed && step('choose a category', () => scrollToAndTap(INTENDED.categoryLabel))) {
      categoryChosen = isSelected(INTENDED.categoryLabel);
      const declaration = typeInto(
        'Ingredients as printed (optional)',
        INTENDED.ingredientDeclaration,
      );
      declarationHeld = declaration.held;
      steps.push(['type the ingredient list', declaration.typed]);

      if (declaration.typed && step('save the product', () => scrollToAndTap('Save'))) {
        sleep(8_000);
        // Read before "Done" is pressed: the outcome screen is the only place the limits are
        // stated, and closing it is what the person does next.
        limitsScreen = collectScreenText();
      }
    }
  }

  checks.push(
    personalCareFormCheck({ steps, intended: INTENDED, nameHeld, declarationHeld, categoryChosen }),
  );

  const after = await shelfItems();
  checks.push(
    personalCareCreatedCheck({
      before,
      after,
      intended: INTENDED,
      profileId: PROFILE_ID,
      // Every step, including the launch. A run that never reached the form has nothing to say
      // about what a save does.
      submitted: steps.every(([, happened]) => happened),
    }),
  );

  const created = (after ?? []).find((item) => item.displayName === INTENDED.displayName) ?? null;
  checks.push(
    storedFieldsCheck({
      categoryFields: created === null ? null : await categoryFields(created.id),
      intended: INTENDED,
    }),
  );

  checks.push(
    limitsStatedCheck({
      screenText: limitsScreen,
      expected: LIMITS_OF_BLANK_FIELDS,
      refused: LIMIT_OF_NO_DECLARATION,
    }),
  );

  // Back to the shelf, then into the item this run made - by its own heading, because every row
  // draws an identically named "Open this item" and a plain lookup opens whichever is first.
  let detailScreen: readonly string[] | null = null;
  if (created !== null && tapNamed('Done')) {
    sleep(6_000);
    if (scrollToAndTapBelow('Open this item', INTENDED.displayName)) {
      sleep(6_000);
      detailScreen = collectScreenText();
    } else {
      captureFailure('personalcare-open-the-item');
    }
  }
  checks.push(notConfirmedCheck({ screenText: detailScreen, stored: created }));

  process.stdout.write(`${formatReport(checks)}\n`);
  process.stdout.write(
    "Not covered by this run, and not by anything else: the scan and OCR halves of `19`'s\n" +
      'personal-care scenario. There is no barcode scanner in this build and no extraction\n' +
      'provider is credentialed (`BLK-007`), so neither is untested - both are unbuilt.\n',
  );
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

void main();
