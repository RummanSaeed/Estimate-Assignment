/**
 * Estimate lifecycle state machine.
 *
 * draft → sent → accepted | rejected
 *
 * accepted/rejected are terminal — re-engagement requires a new estimate,
 * which keeps the financial record immutable once a client has responded.
 * Only drafts are editable or soft-deletable.
 */

export type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'rejected';

export const ESTIMATE_STATUSES: readonly EstimateStatus[] = [
  'draft',
  'sent',
  'accepted',
  'rejected',
] as const;

const TRANSITIONS: Record<EstimateStatus, readonly EstimateStatus[]> = {
  draft: ['sent'],
  sent: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
};

export function isEstimateStatus(value: string): value is EstimateStatus {
  return (ESTIMATE_STATUSES as readonly string[]).includes(value);
}

/** Allowed next statuses from the given status. */
export function allowedTransitions(from: EstimateStatus): readonly EstimateStatus[] {
  return TRANSITIONS[from];
}

/** Whether a transition from → to is permitted by the state machine. */
export function canTransition(from: EstimateStatus, to: EstimateStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Human-readable reason when a transition is not allowed. */
export function transitionError(from: EstimateStatus, to: EstimateStatus): string | null {
  if (from === to) {
    return `Estimate is already ${to}`;
  }
  if (!canTransition(from, to)) {
    if (from === 'accepted' || from === 'rejected') {
      return `Cannot transition from ${from}: estimate is finalized. Create a new estimate to re-engage.`;
    }
    return `Cannot transition from ${from} to ${to}`;
  }
  return null;
}

/** Only draft estimates may be edited. */
export function isEditable(status: EstimateStatus): boolean {
  return status === 'draft';
}

/** Only draft estimates may be soft-deleted. */
export function isDeletable(status: EstimateStatus): boolean {
  return status === 'draft';
}
