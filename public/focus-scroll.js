/* ==========================================================================
   KinKeeper — focus-restore scroll geometry (pure; shared with node tests)
   After a family-card action rebuilds the card, renderInbox restores focus
   to a control inside it and must scroll so the ACTUAL focused control is
   fully visible in the band between the live sticky masthead bottom and the
   viewport bottom. Scrolling only by the card's box leaves a low Why toggle
   below the fold (observed at 375x800: toggle y849.9-893.9 in an 800px
   viewport while the card title sat correctly under the masthead).
   ========================================================================== */

// All inputs are viewport-relative pixel measurements taken AFTER the
// re-render and focus() call. Returns the window.scrollBy delta (positive =
// scroll down) that brings the focused control into the unobscured band with
// the minimum movement, so as much surrounding card context as possible
// stays in view. Returns 0 when no scroll is needed.
export function focusScrollDelta({
  mastBottom,          // live sticky masthead bottom edge (viewport px)
  viewBottom,          // window.innerHeight
  cardTop, cardBottom, // rebuilt card rect
  targetTop, targetBottom, // restored focus target rect
  isCardTarget,        // true when focus fell back to the <article> itself
  pad = 8,             // breathing room around the focused control
  cardPad = 12,        // breathing room when aligning the card title
}) {
  // Fallback: the whole card holds focus (no control inside). Keep the prior
  // behavior — align the card top just under the masthead.
  if (isCardTarget) {
    if (cardTop < mastBottom + pad || cardBottom > viewBottom) {
      return cardTop - (mastBottom + cardPad);
    }
    return 0;
  }

  let delta = 0;
  // Focused control below the viewport bottom: scroll down just enough to
  // show its bottom edge (keeps the most preceding timeline/context visible).
  if (targetBottom > viewBottom - pad) delta = targetBottom - (viewBottom - pad);
  // Focused control tucked under the sticky masthead (or still there after
  // the down-scroll above — a control taller than the band keeps its top
  // visible): scroll up so its top clears the masthead.
  if (targetTop - delta < mastBottom + pad) delta = targetTop - (mastBottom + pad);
  // Focused control already fully visible but the card title slid under the
  // masthead: reveal the title only when that does not push the focused
  // control back out of view.
  if (delta === 0 && cardTop < mastBottom + pad) {
    const titleDelta = cardTop - (mastBottom + pad);
    if (targetBottom - titleDelta <= viewBottom - pad) delta = titleDelta;
  }
  return delta;
}
