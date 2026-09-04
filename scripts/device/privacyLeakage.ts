/**
 * What the privacy-leakage and platform-interaction scenario's evidence means.
 *
 * Spec references: `14` ("Mobile security validation" - privacy leakage, logging, platform
 * interaction, deep links/notifications; "no sensitive tokens/medical details in URLs"), `15`
 * (threat model), `16` (data minimisation), `20` (what may be logged), `19`, `04` Phase 9.2.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached
 * (DEC-102).
 *
 * WHY THIS NEEDS A DEVICE AND CANNOT BE INFERRED
 * The app's own source contains not one `console.*` call, which is easy to check and proves
 * nothing. What reaches the system log is written by React Native, by Expo's modules, by whatever
 * a library does with a response body it could not parse, and by Android itself - none of which is
 * in this repository. `14` lists privacy leakage and logging as categories to test rather than to
 * reason about, and the only way to know is to drive the app over real data and read what came
 * out.
 *
 * THE MEASUREMENT IS THE FIRST THING THAT LIES
 * `uiautomator dump` writes the entire view hierarchy to logcat - every medicine name on screen,
 * as `AccessibilityNodeInfoDumper`, at its own pid. A scan of the whole log after a driven run
 * therefore finds hundreds of lines carrying somebody's medicines and reports the app as leaking
 * health data, when it is the harness doing it. The first version of this file measured exactly
 * that: 204 lines, none of them the app's. So the app's own process is scanned separately, and the
 * system-wide scan names and excludes the instrumentation that only exists because the run is
 * happening.
 *
 * AND AN ABSENCE TEST OVER AN EMPTY CAPTURE PASSES TRIVIALLY
 * The same argument `verify:device`'s `STORAGE-3` needs `KEY-2` for. `PRIV-0` is the control: if
 * the capture holds nothing the app wrote, then "the app wrote nothing sensitive" is a statement
 * about the capture rather than about the app.
 */

import type { Check } from './analysis.js';

/**
 * The strings that must not appear, and what each one would mean if it did.
 *
 * Content rather than identifiers. A correlation ID in a log is what `20` asks for; a medicine
 * name is what `14` calls privacy leakage, and `16` is explicit that the two are different kinds
 * of thing. The profile's display name is included because who somebody is caring for is health
 * data about them even where no medicine is named beside it.
 */
export interface SensitiveStrings {
  readonly medicineNames: readonly string[];
  readonly profileName: string;
  /** A note typed into a dose record during the run, so the scan covers something written today. */
  readonly doseNote: string;
}

export function allSensitiveStrings(strings: SensitiveStrings): readonly string[] {
  return [...strings.medicineNames, strings.profileName, strings.doseNote].filter(
    (value) => value.trim() !== '',
  );
}

/** Every sensitive string that appears anywhere in `lines`, with the line that carried it. */
export function leaksIn(
  lines: readonly string[],
  strings: SensitiveStrings,
): readonly { readonly value: string; readonly line: string }[] {
  const wanted = allSensitiveStrings(strings);
  const found: { value: string; line: string }[] = [];
  for (const line of lines) {
    for (const value of wanted) {
      if (line.includes(value)) found.push({ value, line });
    }
  }
  return found;
}

/**
 * The tag `uiautomator dump` writes the whole screen under.
 *
 * Excluded from the system-wide scan, by name and with the reason attached, because it exists only
 * because a harness is looking. Excluding it is not weakening the check: it is the difference
 * between measuring the app and measuring the act of measuring the app.
 */
export const INSTRUMENTATION_TAGS = ['AccessibilityNodeInfoDumper'] as const;

export function withoutInstrumentation(lines: readonly string[]): readonly string[] {
  return lines.filter((line) => !INSTRUMENTATION_TAGS.some((tag) => line.includes(tag)));
}

// ---------------------------------------------------------------------------
// PRIV-0 - the control
// ---------------------------------------------------------------------------

export interface CaptureEvidence {
  /** Lines logcat attributed to the app's own process. */
  readonly appLines: readonly string[] | null;
  /** Whether the run reached the screens that hold health data. */
  readonly driven: boolean;
}

/**
 * The app's log was actually captured, and the screens were actually opened.
 *
 * Two failures this rules out, both of which look like a clean result. A capture that came back
 * empty - a wrong pid, a cleared buffer, a process that never started - makes every absence test
 * below pass over nothing. And a run that never reached the shelf has not put a medicine name
 * anywhere near a logger, so it would report a clean log about an app that was never asked to
 * handle any data (trap 195's shape).
 */
export function captureControlCheck(evidence: CaptureEvidence): Check {
  const title = 'The app’s own log was captured, over screens that held health data';
  if (evidence.appLines === null) {
    return {
      id: 'PRIV-0',
      title,
      status: 'INCONCLUSIVE',
      detail: 'logcat could not be read for the app’s process.',
    };
  }
  if (!evidence.driven) {
    return {
      id: 'PRIV-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The run never reached the shelf, so the app was never asked to handle a medicine. A ' +
        'clean log here would be a statement about the run rather than about the app.',
    };
  }
  if (evidence.appLines.length === 0) {
    return {
      id: 'PRIV-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The capture is empty. An absence test over an empty input passes trivially (DEC-102), ' +
        'so nothing below would mean anything.',
    };
  }
  return {
    id: 'PRIV-0',
    title,
    status: 'PASS',
    detail:
      `${String(evidence.appLines.length)} line(s) came from the app's own process after a cold ` +
      'start and a drive through the shelf, an item and its dose history.',
  };
}

// ---------------------------------------------------------------------------
// PRIV-1 - what the app itself wrote
// ---------------------------------------------------------------------------

export interface AppLogEvidence {
  readonly appLines: readonly string[] | null;
  readonly strings: SensitiveStrings;
}

/**
 * The app writes nothing about somebody's medicines to the system log.
 *
 * `14`'s privacy-leakage category, at the one place a mobile app leaks by accident rather than by
 * design. Anything on Android's log is readable by the platform and by anyone with a debug bridge,
 * survives the app's own storage guarantees entirely, and is not covered by SQLCipher, the
 * keystore, or any policy this codebase writes - `verify:device` proves the database is
 * unreadable, and a medicine name in logcat walks around all of it.
 */
export function appLogCheck(evidence: AppLogEvidence): Check {
  const title = 'The app writes nothing about somebody’s medicines to the system log';
  if (evidence.appLines === null) {
    return {
      id: 'PRIV-1',
      title,
      status: 'INCONCLUSIVE',
      detail: 'logcat could not be read for the app’s process.',
    };
  }
  const leaks = leaksIn(evidence.appLines, evidence.strings);
  if (leaks.length > 0) {
    const values = [...new Set(leaks.map((leak) => leak.value))];
    return {
      id: 'PRIV-1',
      title,
      status: 'FAIL',
      detail:
        `${String(leaks.length)} line(s) from the app's own process carry ` +
        `${JSON.stringify(values)}. The system log is outside every storage guarantee this build ` +
        'makes: the database is encrypted and its key is in the keystore, and a medicine name ' +
        'written here walks around both.',
    };
  }
  return {
    id: 'PRIV-1',
    title,
    status: 'PASS',
    detail:
      `None of ${String(allSensitiveStrings(evidence.strings).length)} sensitive string(s) ` +
      `appears in the ${String(evidence.appLines.length)} line(s) the app's process wrote.`,
  };
}

// ---------------------------------------------------------------------------
// PRIV-2 - and nothing else wrote it on the app's behalf
// ---------------------------------------------------------------------------

export interface SystemLogEvidence {
  /** Every line in the system log, the harness's own instrumentation already removed. */
  readonly systemLines: readonly string[] | null;
  /** How many lines were removed as instrumentation, for the report. */
  readonly instrumentationLines: number;
  readonly strings: SensitiveStrings;
}

/**
 * No other process carried it either.
 *
 * The app's own pid is not the whole question. A crash reporter, an IPC, a system service handed a
 * string, or a library running in another process would all put health data on the same log
 * without a single line being attributed to the app - and that is the same exposure by a different
 * route.
 *
 * What is removed first is `uiautomator dump`, which writes every visible view to logcat and
 * exists only because a harness is looking (see the module comment). Removing it is what makes
 * this a measurement of the app rather than of the measurement.
 */
export function systemLogCheck(evidence: SystemLogEvidence): Check {
  const title = 'No other process carried somebody’s medicines onto the log either';
  if (evidence.systemLines === null) {
    return {
      id: 'PRIV-2',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The system log could not be read.',
    };
  }
  const leaks = leaksIn(evidence.systemLines, evidence.strings);
  if (leaks.length > 0) {
    const values = [...new Set(leaks.map((leak) => leak.value))];
    const sample = leaks[0]?.line.slice(0, 160) ?? '';
    return {
      id: 'PRIV-2',
      title,
      status: 'FAIL',
      detail:
        `${String(leaks.length)} line(s) outside the app's process carry ${JSON.stringify(values)}. ` +
        `First: ${sample}`,
    };
  }
  return {
    id: 'PRIV-2',
    title,
    status: 'PASS',
    detail:
      `Clean across ${String(evidence.systemLines.length)} line(s), after removing ` +
      `${String(evidence.instrumentationLines)} written by \`uiautomator dump\` - which puts the ` +
      'whole screen on the log and exists only because this run is happening.',
  };
}

// ---------------------------------------------------------------------------
// PLAT-1 - what the package exposes to other apps
// ---------------------------------------------------------------------------

/**
 * The components this package may expose, and who owns each.
 *
 * The app's own code declares exactly one: the launcher activity, which has to be exported or
 * nothing could start it. Everything else belongs to a library that the build pulled in, and each
 * is listed by name rather than by a prefix rule - `expo.modules.*` as a wildcard would admit a
 * future Expo module that exposes something this project would want to look at.
 *
 * The check is a regression detector, not a verdict on each entry: what it catches is a component
 * appearing that nobody in this repository decided to expose.
 */
export const KNOWN_COMPONENTS: readonly string[] = Object.freeze([
  'com.kynviora.app/.MainActivity',
  'com.kynviora.app/androidx.profileinstaller.ProfileInstallReceiver',
  'com.kynviora.app/androidx.startup.InitializationProvider',
  'com.kynviora.app/com.google.firebase.iid.FirebaseInstanceIdReceiver',
  'com.kynviora.app/com.google.firebase.messaging.FirebaseMessagingService',
  'com.kynviora.app/com.google.firebase.provider.FirebaseInitProvider',
  'com.kynviora.app/expo.modules.filesystem.FileSystemFileProvider',
  'com.kynviora.app/expo.modules.notifications.service.ExpoFirebaseMessagingService',
  'com.kynviora.app/expo.modules.notifications.service.NotificationsService',
]);

export interface ComponentEvidence {
  /** Every component the installed package declares. */
  readonly components: readonly string[] | null;
}

export function componentSurfaceCheck(evidence: ComponentEvidence): Check {
  const title = 'The package exposes only the components this build knows about';
  if (evidence.components === null || evidence.components.length === 0) {
    return {
      id: 'PLAT-1',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The package’s components could not be read.',
    };
  }
  // Bound once, so the narrowing survives into the closure below - a property read inside a
  // callback is not narrowed by the guard above.
  const declared = evidence.components;
  const known = new Set(KNOWN_COMPONENTS);
  const unexpected = declared.filter((component) => !known.has(component));
  if (unexpected.length > 0) {
    return {
      id: 'PLAT-1',
      title,
      status: 'FAIL',
      detail:
        `${String(unexpected.length)} component(s) nobody here decided to expose: ` +
        `${JSON.stringify(unexpected)}. Each one is a way into this app from another app, so it ` +
        'belongs on the list with a reason or it does not belong in the package.',
    };
  }
  const missing = KNOWN_COMPONENTS.filter((component) => !declared.includes(component));
  if (missing.length > 0) {
    return {
      id: 'PLAT-1',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `${String(missing.length)} known component(s) were not found: ${JSON.stringify(missing)}. ` +
        'The list and the package have drifted, so an unexpected one could be hiding behind a ' +
        'stale expectation.',
    };
  }
  return {
    id: 'PLAT-1',
    title,
    status: 'PASS',
    detail:
      `All ${String(declared.length)} declared component(s) are accounted for: one ` +
      'launcher activity this project wrote, and eight belonging to Expo, AndroidX and Firebase.',
  };
}

// ---------------------------------------------------------------------------
// PLAT-2 - what a link from another app can decide
// ---------------------------------------------------------------------------

export interface DeepLinkEvidence {
  /** Whether the app was running before the link was fired. It must not have been. */
  readonly runningBefore: boolean;
  /** Whether the link started the app at all - the positive control. */
  readonly opened: boolean;
  /** The medicine names on the shelf after an ordinary launch. */
  readonly ordinary: readonly string[] | null;
  /** The medicine names on the shelf after the link, which carried a foreign profile ID. */
  readonly afterLink: readonly string[] | null;
}

/**
 * A link from another app cannot choose whose medicines this phone shows.
 *
 * The app registers a `BROWSABLE` `kynviora://` scheme, so any web page or installed app can open
 * it. That is Expo Router's default and it is a real surface: the question `15` asks is not
 * whether the link opens the app but whether what it carries can decide anything.
 *
 * A profile ID in the link is the sharpest version, because it is the one parameter that selects
 * whose health data a screen renders. `shelf.tsx` takes it from `ProfileProvider` and never from
 * route params, so the answer should be that the link changes nothing - and "should be" is why
 * this is measured rather than read.
 *
 * `opened` is the control and it matters more than it looks. A link that never started the app
 * leaves the shelf trivially unchanged, so a run without it reports "the link decided nothing"
 * about a link that did nothing at all.
 *
 * What this deliberately does **not** judge: that the scheme exists. Whether Kynviora wants a deep
 * link is a product question - the invitation flow hands somebody a link and the copy already
 * warns that anyone opening it can accept - and it is entangled with an authentication provider
 * nobody has chosen (`BLK-010`). Recorded as `DEV-052`, not decided here.
 */
export function deepLinkCheck(evidence: DeepLinkEvidence): Check {
  const title = 'A link from another app cannot choose whose medicines are shown';
  if (evidence.ordinary === null || evidence.afterLink === null) {
    return {
      id: 'PLAT-2',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The shelf could not be read on one side of the comparison.',
    };
  }
  if (evidence.runningBefore) {
    return {
      id: 'PLAT-2',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The app was already running when the link was fired, so it may have been resumed rather ' +
        'than started by it - and `opened` would then be true of the wrong thing.',
    };
  }
  if (!evidence.opened) {
    return {
      id: 'PLAT-2',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The link did not start the app, so an unchanged shelf says nothing: a link that does ' +
        'nothing decides nothing, and that is not the property being measured.',
    };
  }
  if (evidence.ordinary.length === 0) {
    return {
      id: 'PLAT-2',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The ordinary launch showed no medicines, so a shelf that matches it afterwards would ' +
        'match an empty one.',
    };
  }

  const before = [...evidence.ordinary].sort();
  const after = [...evidence.afterLink].sort();
  if (before.length !== after.length || before.some((name, index) => name !== after[index])) {
    return {
      id: 'PLAT-2',
      title,
      status: 'FAIL',
      detail:
        `The shelf showed ${JSON.stringify(before)} on an ordinary launch and ` +
        `${JSON.stringify(after)} after a link carrying a profile ID that is not this ` +
        'household’s. A link from another app decided which person’s medicines were rendered.',
    };
  }
  return {
    id: 'PLAT-2',
    title,
    status: 'PASS',
    detail:
      `The link started the app and the shelf showed the same ${String(before.length)} ` +
      'medicine(s) as an ordinary launch. The profile comes from the provider, never from what ' +
      'the link carried.',
  };
}
