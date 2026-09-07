/**
 * A scripted agent in a development build, so a device harness can drive a real conversation.
 *
 * Spec references: `19` (a device scenario measures what only a device can show), `17` (no
 * provider is chosen here), `14` (a development affordance says what it is and grants nothing).
 * DEC-136, `BLK-012`, `DEV-073`.
 *
 * WHY THIS EXISTS
 * With no provider (`BLK-012`) the app understands nothing, so the only thing a device could show
 * about Voice Mode is that the screen renders. The confirmation flow, the touch-only refusal and
 * the very large controls are the parts worth measuring on hardware, and none of them can be
 * reached without something that turns a sentence into a proposal.
 *
 * WHAT IT IS NOT
 * It is not a model, it does not become one, and it is not a step towards one. It is
 * `createScriptedAgent` - a list of regular expressions - behind an environment variable that is
 * absent in every ordinary run. It grants nothing: every proposal it makes goes through the same
 * six gates as any other, which is exactly what the harness is measuring.
 *
 * WHY IT IS SAFE TO SHIP THE CODE
 * The flag defaults to off and the script is a fixed list; there is no path from a person's speech
 * to it because nothing listens. Its most useful scripts are the ones that **misbehave** - a
 * proposal to close the account, one to change a dose - because those are what the gates exist for
 * and what a device run should show being refused.
 */

import { createScriptedAgent, demonstrationScript, type VoiceProviders } from '@kynviora/agent';

/**
 * The providers this build runs with.
 *
 * `null` everywhere unless `EXPO_PUBLIC_DEV_VOICE_SCRIPT=1`, and even then the recogniser and the
 * synthesizer stay `null` - a fake microphone would be a fake measurement, and there is nothing to
 * script them with. What the flag adds is the middle of the three: the thing that turns a typed
 * sentence into a proposal.
 */
export function resolveVoiceProviders(
  env: Readonly<Record<string, string | undefined>>,
  profileId: string | null,
): VoiceProviders {
  if (env['EXPO_PUBLIC_DEV_VOICE_SCRIPT'] !== '1') {
    return { recognizer: null, agent: null, synthesizer: null };
  }
  // The medicine the item-scoped scripts name, from the environment rather than from a read.
  //
  // It used to be a parameter and the caller passed `null` to it, so every script carrying an item
  // - both doses, the missing-fields question and the reminder - was proposed with an empty string
  // and refused as malformed. `demonstrationScript` now leaves such a rule out rather than emitting
  // one that can only be refused, and this is where the value comes from (`DEV-095`).
  //
  // The environment rather than the shelf, for the reason the development user ID is there too:
  // a read would be a request on every launch of every build to serve a flag that is off in all of
  // them, and `VoiceProvider` deliberately does not depend on which tab somebody last opened.
  const itemId = env['EXPO_PUBLIC_DEV_VOICE_ITEM_ID'] ?? null;
  return {
    recognizer: null,
    // The identifiers name rows that actually exist, so a proposal is refused by the gate under
    // test rather than by the route - which is the wrong measurement passing for the right one.
    agent: createScriptedAgent(demonstrationScript(profileId, itemId)),
    synthesizer: null,
  };
}
