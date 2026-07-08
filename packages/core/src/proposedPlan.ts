const PROPOSED_PLAN_OPEN = "<proposed_plan>";
const PROPOSED_PLAN_CLOSE = "</proposed_plan>";

export function hasCompleteProposedPlan(text: string): boolean {
  let cursor = 0;
  while (cursor < text.length) {
    const openIndex = text.indexOf(PROPOSED_PLAN_OPEN, cursor);
    if (openIndex === -1) return false;
    const closeIndex = text.indexOf(PROPOSED_PLAN_CLOSE, openIndex + PROPOSED_PLAN_OPEN.length);
    if (closeIndex !== -1) return true;
    cursor = openIndex + PROPOSED_PLAN_OPEN.length;
  }
  return false;
}

export function hasIncompleteProposedPlan(text: string): boolean {
  let cursor = 0;
  while (cursor < text.length) {
    const openIndex = text.indexOf(PROPOSED_PLAN_OPEN, cursor);
    if (openIndex === -1) return false;
    const closeIndex = text.indexOf(PROPOSED_PLAN_CLOSE, openIndex + PROPOSED_PLAN_OPEN.length);
    if (closeIndex === -1) return true;
    cursor = closeIndex + PROPOSED_PLAN_CLOSE.length;
  }
  return false;
}
