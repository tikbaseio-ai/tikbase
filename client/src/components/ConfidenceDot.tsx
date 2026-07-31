/**
 * Confidence marker for a revenue figure.
 *
 * The payload has carried hasRealDelta/hasRealPrice since the first ranking
 * shipped and the table never rendered either, so every number looked equally
 * solid — a modelled guess and a measured day-over-day delta were the same
 * pixels. This makes the difference visible at a glance:
 *
 *   green  — measured: units come from a real snapshot delta
 *   amber  — modelled: units estimated from views until sales history accrues
 *
 * The price flag is reported in the tooltip rather than as a third colour: a
 * measured unit count with an estimated price is still a fundamentally better
 * number than a modelled one, and two dimensions of colour would read as four
 * states nobody can remember.
 */
export function ConfidenceDot({
  hasRealDelta,
  hasRealPrice,
}: {
  hasRealDelta: boolean;
  hasRealPrice: boolean;
}) {
  const title = hasRealDelta
    ? `Measured: units sold came from a real day-over-day sales snapshot.${
        hasRealPrice ? ' Price is the listed price.' : ' Price estimated from the category median.'
      }`
    : `Modeled: units sold estimated from video views — no usable sales snapshot for this window yet.${
        hasRealPrice ? ' Price is the listed price.' : ' Price also estimated from the category median.'
      }`;

  return (
    <span
      title={title}
      className="inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 cursor-help"
      style={{ backgroundColor: hasRealDelta ? '#a3ff00' : '#f59e0b' }}
      data-testid={`confidence-${hasRealDelta ? 'measured' : 'modeled'}`}
    />
  );
}
