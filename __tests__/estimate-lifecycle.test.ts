import { describe, it, expect } from 'vitest';
import {
  allowedTransitions,
  canTransition,
  isDeletable,
  isEditable,
  isEstimateStatus,
  transitionError,
  ESTIMATE_STATUSES,
  type EstimateStatus,
} from '@/lib/estimate-lifecycle';

describe('estimate lifecycle state machine', () => {
  it('allows draft → sent', () => {
    expect(canTransition('draft', 'sent')).toBe(true);
  });

  it('allows sent → accepted and sent → rejected', () => {
    expect(canTransition('sent', 'accepted')).toBe(true);
    expect(canTransition('sent', 'rejected')).toBe(true);
  });

  it('terminal states allow no transitions', () => {
    expect(allowedTransitions('accepted')).toHaveLength(0);
    expect(allowedTransitions('rejected')).toHaveLength(0);
    expect(canTransition('accepted', 'draft')).toBe(false);
    expect(canTransition('rejected', 'sent')).toBe(false);
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('draft', 'accepted')).toBe(false);
    expect(canTransition('draft', 'rejected')).toBe(false);
    expect(canTransition('sent', 'draft')).toBe(false);
  });

  it('produces helpful error messages', () => {
    expect(transitionError('draft', 'sent')).toBeNull();
    expect(transitionError('draft', 'accepted')).toContain('Cannot transition');
    expect(transitionError('accepted', 'sent')).toContain('finalized');
    expect(transitionError('sent', 'sent')).toContain('already sent');
  });
});

describe('edit/delete rules', () => {
  it('only drafts are editable and deletable', () => {
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('sent')).toBe(false);
    expect(isEditable('accepted')).toBe(false);
    expect(isEditable('rejected')).toBe(false);

    expect(isDeletable('draft')).toBe(true);
    expect(isDeletable('sent')).toBe(false);
    expect(isDeletable('accepted')).toBe(false);
    expect(isDeletable('rejected')).toBe(false);
  });
});

describe('status validation', () => {
  it('recognizes valid statuses', () => {
    for (const s of ESTIMATE_STATUSES) {
      expect(isEstimateStatus(s)).toBe(true);
    }
    expect(isEstimateStatus('pending')).toBe(false);
    expect(isEstimateStatus('')).toBe(false);
  });

  it('covers the full lifecycle matrix', () => {
    const statuses: EstimateStatus[] = ['draft', 'sent', 'accepted', 'rejected'];
    // Every status must have a defined transition set
    for (const s of statuses) {
      expect(Array.isArray(allowedTransitions(s))).toBe(true);
    }
  });
});
