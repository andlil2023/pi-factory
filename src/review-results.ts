import { isDeepStrictEqual } from 'node:util';
import type { ReviewResult } from './orchestrator.ts';

/** Save validated reports incrementally without allowing later batch output to erase them. */
export function appendReviewResult(saved: ReviewResult[], review: ReviewResult, required: readonly string[]): void {
  if (!required.includes(review.reviewer) || saved.some(previous => previous.reviewer === review.reviewer) || !['approved', 'changes_requested', 'blocked'].includes(review.verdict)) throw new Error('Invalid incremental reviewer result');
  saved.push(structuredClone(review));
}

export function reconcileReviewResults(saved: readonly ReviewResult[], finished: ReviewResult[]): ReviewResult[] {
  for (const previous of saved) {
    const matches = finished.filter(review => review.reviewer === previous.reviewer);
    if (matches.length !== 1 || !isDeepStrictEqual(previous, matches[0])) throw new Error('Review batch changed or omitted an already persisted result');
  }
  return structuredClone(finished);
}
