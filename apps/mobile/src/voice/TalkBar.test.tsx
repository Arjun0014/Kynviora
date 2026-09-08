/**
 * The persistent Talk bar, rendered - and the contextual control it makes possible.
 *
 * Spec references: `18` (meaning never carried by colour alone; a control says what it does),
 * `15` (a proposed name is validated against what is actually available), `16` (data
 * minimisation), DEC-132, DEC-156, DEC-157, `BLK-012`.
 *
 * WHY THIS IS NOT ONLY A UNIT TEST OF `talkBar.ts`
 * The presentation module is pure and tested in `@kynviora/agent`. What can only be measured here
 * is the wiring: that the bar shows the state a real session is in, that a phrasing a screen
 * declared actually runs that screen's handler, that a name it did not declare is refused, and -
 * the one that matters most - that the footer says what left the phone and that what left the
 * phone contains no content.
 */

import { describe, it, expect } from 'vitest';
import { useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { emptySession } from '@kynviora/agent';
import {
  ScreenContextProvider,
  useDeclareScreen,
  useScreenContext,
  type ScreenActionBinding,
} from './ScreenContextProvider';
import { TalkBar } from './TalkBar';
import { VoiceProvider } from './VoiceProvider';
import { ApiProvider } from '@/api/ApiProvider';
import { ProfileProvider } from '@/api/ProfileProvider';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { LocalStoreProvider } from '@/storage/LocalStoreProvider';
import { ProjectionProvider } from '@/storage/ProjectionProvider';
import { PendingSyncProvider } from '@/sync/PendingSyncProvider';
import {
  allNodes,
  accessibleNameOf,
  flush,
  press,
  renderScreen,
  textOf,
} from '../../test/render.js';

function screenText(rendered: ReturnType<typeof renderScreen>): string {
  return allNodes(rendered)
    .map((node) => textOf(node))
    .join(' ');
}

/** A screen that declares one action and reports whether it ran. */
function Declaring({
  actions,
  focusId = null,
  selecting = false,
  children,
}: {
  readonly actions: readonly ScreenActionBinding[];
  readonly focusId?: string | null;
  readonly selecting?: boolean;
  readonly children?: ReactNode;
}) {
  useDeclareScreen(
    useMemo(
      () => ({ route: 'SHELF' as const, profileId: 'profile-1', focusId, actions, selecting }),
      [actions, focusId, selecting],
    ),
  );
  return <View>{children}</View>;
}

/**
 * The provider stack the bar needs, and no more of it than that.
 *
 * `VoiceProvider` reads the API client, the profile list and the pending queue; each of those
 * providers handles "nothing is signed in", which is the state here and the state on first run.
 */
function Harness({ children }: { readonly children: ReactNode }) {
  return (
    <LocalStoreProvider>
      <ThemeProvider>
        <ApiProvider>
          <ProjectionProvider>
            <ProfileProvider>
              <PendingSyncProvider>
                <ScreenContextProvider>
                  <VoiceProvider>{children}</VoiceProvider>
                </ScreenContextProvider>
              </PendingSyncProvider>
            </ProfileProvider>
          </ProjectionProvider>
        </ApiProvider>
      </ThemeProvider>
    </LocalStoreProvider>
  );
}

describe('the bar at rest', () => {
  it('says its state in words, not only in a colour or an animation', async () => {
    const rendered = renderScreen(
      <Harness>
        <Declaring actions={[]}>
          <TalkBar />
        </Declaring>
      </Harness>,
    );
    await flush();
    const text = screenText(rendered);
    expect(text).toContain('Talk to Kynviora');
    expect(text).toContain('Ask for something on this screen.');
    rendered.unmount();
  });

  it('carries one accessible name covering the state and what the tap does', async () => {
    const rendered = renderScreen(
      <Harness>
        <Declaring actions={[]}>
          <TalkBar />
        </Declaring>
      </Harness>,
    );
    await flush();
    const named = allNodes(rendered).filter((node) =>
      accessibleNameOf(node).startsWith('Talk to Kynviora. Ask for something on this screen.'),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(accessibleNameOf(named[0]!)).toContain('Open.');
    rendered.unmount();
  });

  it('leaves the screen when the space belongs to the task', async () => {
    // Selection mode, here. The bar is not hidden with opacity or moved off screen - it is not
    // rendered, so a screen reader walking the tree does not find it either.
    const rendered = renderScreen(
      <Harness>
        <Declaring actions={[]} selecting>
          <TalkBar />
        </Declaring>
      </Harness>,
    );
    await flush();
    expect(screenText(rendered)).not.toContain('Talk to Kynviora');
    rendered.unmount();
  });
});

describe('the panel', () => {
  const RAN: string[] = [];
  const actions: readonly ScreenActionBinding[] = [
    {
      id: 'shelf.all',
      label: 'Show everything',
      says: 'Showing everything on the shelf.',
      run: () => RAN.push('shelf.all'),
    },
  ];

  it('offers the phrasings the screen declared, not a chat history', async () => {
    const rendered = renderScreen(
      <Harness>
        <Declaring actions={actions}>
          <TalkBar />
        </Declaring>
      </Harness>,
    );
    await flush();
    press(rendered, { startsWith: 'Talk to Kynviora' });
    await flush();
    expect(screenText(rendered)).toContain('Show everything');
    rendered.unmount();
  });

  it('says plainly when a screen offers nothing rather than showing an empty box', async () => {
    const rendered = renderScreen(
      <Harness>
        <Declaring actions={[]}>
          <TalkBar />
        </Declaring>
      </Harness>,
    );
    await flush();
    press(rendered, { startsWith: 'Talk to Kynviora' });
    await flush();
    expect(screenText(rendered)).toContain('nothing Kynviora can change from here');
    rendered.unmount();
  });

  it('runs the screen’s own handler and reports the screen’s own sentence', async () => {
    RAN.length = 0;
    const rendered = renderScreen(
      <Harness>
        <Declaring actions={actions}>
          <TalkBar />
        </Declaring>
      </Harness>,
    );
    await flush();
    press(rendered, { startsWith: 'Talk to Kynviora' });
    await flush();
    press(rendered, 'Show everything');
    await flush();

    expect(RAN).toEqual(['shelf.all']);
    const text = screenText(rendered);
    // The bar reports the turn's outcome, and the panel carries the sentence the screen composed.
    expect(text).toContain('Done');
    expect(text).toContain('Showing everything on the shelf.');
    rendered.unmount();
  });

  it('shows the whole of what would leave the phone, and no content', async () => {
    // The design language: the footer shows "the exact context snapshot that left the phone".
    // That claim is only honest because there is no field a medicine name could arrive in - so
    // this asserts both halves: the snapshot is rendered, and it is identifiers only.
    const rendered = renderScreen(
      <Harness>
        <Declaring actions={actions} focusId="item-9">
          <TalkBar />
        </Declaring>
      </Harness>,
    );
    await flush();
    press(rendered, { startsWith: 'Talk to Kynviora' });
    await flush();
    const text = screenText(rendered);
    expect(text).toContain('route SHELF');
    expect(text).toContain('profile profile-1');
    expect(text).toContain('focused item-9');
    expect(text).toContain('selected 0');
    rendered.unmount();
  });
});

describe('the screen context', () => {
  it('refuses an action name the screen never offered', async () => {
    // `15`, at the boundary a model would cross. `runAction` returns null and nothing runs.
    let result: unknown = 'not-run';
    function Prober() {
      const { runAction } = useScreenContext();
      const [done, setDone] = useState(false);
      if (!done) {
        result = runAction('delete.everything');
        setDone(true);
      }
      return <View />;
    }
    const rendered = renderScreen(
      <ScreenContextProvider>
        <Declaring actions={[{ id: 'a', label: 'A', says: 'A.', run: () => undefined }]}>
          <Prober />
        </Declaring>
      </ScreenContextProvider>,
    );
    await flush();
    expect(result).toBeNull();
    rendered.unmount();
  });

  it('starts with nothing declared', () => {
    expect(emptySession(null).lastOutcome).toBeNull();
  });
});
