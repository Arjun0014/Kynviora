/**
 * The Compare screen: what a few labels declare, side by side.
 *
 * Spec references: `09` (a fact about a label is not a claim about a product), `23` D-014 (an
 * absence must never render as approval), `18` (a mark never carries meaning alone; a limitation
 * travels with the fact it qualifies; the whole thing has to survive font scale 2), `02` (no
 * score, no ranking), DEC-162.
 *
 * THIS SCREEN COMPOSES NOTHING
 * Every cell's word, every qualification and the sentence for "nothing in common" arrive from
 * `@kynviora/presentation`, and the comparison itself arrives from the server. What is decided
 * here is layout - and one thing that is not layout, which is where the qualifications go.
 *
 * THE QUALIFICATIONS ARE ABOVE THE TABLE
 * `09` requires a limitation to travel with the fact it qualifies, and DEC-138 settled what that
 * means when the fact is a whole list: the qualification goes first, at the same rank. A person
 * scanning four columns of marks has formed a conclusion by the time they reach a footnote, and on
 * a longer comparison the footnote is below the fold.
 *
 * A ROW IS A ROW AND NOT A GRID
 * Drawn as one block per ingredient with a line per product rather than as a table with columns.
 * A four-column table on a phone at font scale 2 either scrolls sideways - which hides the column
 * headings the marks are meaningless without - or truncates the product names, and `18` forbids
 * both. One block per term costs vertical space and keeps every mark beside the name of the
 * product it is about and the word that says what it means.
 */

import { View, StyleSheet } from 'react-native';
import {
  RADIUS,
  SPACING,
  comparisonQualifications,
  nothingSharedNote,
  presentComparisonCell,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import type { CompareView } from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { SectionHeader } from '@/components/SectionHeader';
import { StatusChip } from '@/components/StatusChip';
import { Typography } from '@/components/Typography';
import { useThemedStyles } from '@/theme/ThemeProvider';

export interface CompareProductsProps {
  readonly comparison: CompareView | null;
  readonly state: ScreenStateKind;
  readonly message?: string | null;
  readonly onClose: () => void;
}

export function CompareProducts({ comparison, state, message, onClose }: CompareProductsProps) {
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={styles.stack}>
      {/* Nothing at all on a successful read. `ScreenState` draws every state it is given,
          including `READY` - which put "Up to date. This is what Kynviora has right now." at the
          top of a comparison that had loaded, above the qualifications that are the thing a person
          has to read. Found on a device, not in a test. `ResourceState` applies the same rule for
          every other screen; this component takes a bare state rather than a resource, so it
          applies it itself. */}
      {state === 'READY' ? null : (
        <ScreenState state={state} {...(message === undefined ? {} : { message })} />
      )}

      {comparison === null ? null : (
        <>
          {/* First, at the same rank as the comparison itself (DEC-138). Each line is a
              limitation rather than a summary - `02` forbids the summary. */}
          {comparisonQualifications({
            productCount: comparison.products.length,
            declaringCount: comparison.declaringCount,
            notAvailableCount: comparison.notAvailableCount,
            matchedByPrintedTermOnly: comparison.matchedByPrintedTermOnly,
          }).map((line) => (
            <Card key={line} tone="informational">
              <Typography role="body" colour="informational">
                {line}
              </Typography>
            </Card>
          ))}

          <SectionHeader
            title="What you are comparing"
            explanation="Three separate statements about each one, never merged into a verdict."
          />
          {comparison.products.map((product, index) => (
            <Card key={product.id}>
              <Typography role="title" heading>
                {/* The column number, because every mark below is named by it. Without it a
                    person reading the third line of a block has to count. */}
                {String(index + 1)}. {product.displayName}
              </Typography>
              {product.brand === null ? null : (
                <Typography role="caption" colour="secondary">
                  {product.brand}
                </Typography>
              )}
              {/* A presentation this build could not read is absent rather than a blank chip,
                  which on a comparison would read as a state nobody assigned. */}
              <View style={styles.chips}>
                {product.identity === null ? null : <StatusChip presentation={product.identity} />}
                {product.formulation === null ? null : (
                  <StatusChip presentation={product.formulation} />
                )}
                {product.batch === null ? null : <StatusChip presentation={product.batch} />}
              </View>
              <Typography role="caption" colour="secondary">
                {product.hasDeclaration
                  ? `${String(product.declaredTermCount)} ingredients recorded.`
                  : 'No ingredient list recorded.'}
              </Typography>
            </Card>
          ))}

          <SectionHeader
            title="On every label"
            explanation="Ingredients each of these lists. Matched by how they are printed."
          />
          <Card>
            {comparison.shared.length === 0 ? (
              <Typography role="body">
                {nothingSharedNote({
                  sharedCount: comparison.shared.length,
                  productCount: comparison.products.length,
                  declaringCount: comparison.declaringCount,
                })}
              </Typography>
            ) : (
              comparison.shared.map((row) => (
                <Typography key={row.term} role="body">
                  {row.term}
                </Typography>
              ))
            )}
          </Card>

          <SectionHeader
            title="Where the labels differ"
            explanation="One block per ingredient, with what each label says about it."
          />
          {comparison.differing.map((row) => (
            <Card key={row.term}>
              <Typography role="label">{row.term}</Typography>
              {row.cells.map((cell, index) => {
                // Already narrowed by `compareView`: a value this build cannot read arrives as
                // the unknown cell, which is `14`'s deny-by-default applied to a mark.
                const presented = presentComparisonCell(cell);
                const product = comparison.products[index];
                return (
                  <View
                    key={`${row.term}:${String(index)}`}
                    style={styles.cell}
                    accessible
                    // The whole statement, because a screen reader reading a row of marks left to
                    // right learns nothing. Product, then what its label says.
                    accessibilityLabel={`${String(index + 1)}. ${
                      product?.displayName ?? 'This product'
                    }: ${presented.label}.`}
                  >
                    <Typography role="caption" decorative style={styles.mark}>
                      {presented.mark}
                    </Typography>
                    <Typography
                      role="caption"
                      colour="secondary"
                      decorative
                      style={styles.cellText}
                    >
                      {String(index + 1)}. {presented.label}
                    </Typography>
                  </View>
                );
              })}
            </Card>
          ))}

          {/* The legend last, because by here a person has met every mark and the question is what
              one of them meant - not before, where it is three sentences in front of the thing
              they came to read. */}
          <SectionHeader title="What the marks mean" />
          <Card>
            {(['DECLARED', 'NOT_DECLARED', 'NO_DECLARATION'] as const).map((cell) => {
              const presented = presentComparisonCell(cell);
              return (
                <View key={cell} style={styles.legend}>
                  <Typography role="label" decorative>
                    {presented.mark} {presented.label}
                  </Typography>
                  <Typography role="caption" colour="secondary">
                    {presented.meaning}
                  </Typography>
                </View>
              );
            })}
          </Card>
        </>
      )}

      <PrimaryButton label="Back to the shelf" variant="secondary" onPress={onClose} />
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    stack: { gap: SPACING.md },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
    cell: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.xs },
    // Fixed width so the marks line up down a block, and a minimum rather than a height so it
    // grows with the font scale instead of clipping (`18`).
    mark: { minWidth: SPACING.lg, color: theme.canvas.foreground },
    cellText: { flexShrink: 1 },
    legend: {
      gap: SPACING.xxs,
      paddingVertical: SPACING.xs,
      borderRadius: RADIUS.sm,
    },
  });
}
