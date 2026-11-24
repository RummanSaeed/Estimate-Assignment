'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ArrowLeft, Plus, Save, Send, Trash2, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-config';
import { computeEstimateTotals, formatMinor, majorToMinor } from '@/lib/estimate-money';
import { isEditable } from '@/lib/estimate-lifecycle';
import type { Estimate, EstimateStatus } from '@/lib/estimate-service';

interface EstimateEditorProps {
  accountId: string;
  accountName: string;
  projects: { id: string; name: string }[];
  estimate: Estimate | null;
  isNew: boolean;
  canManage: boolean;
  canSend: boolean;
}

interface LineItemDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string; // major units, e.g. "19.99"
}

const STATUS_STYLES: Record<EstimateStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  sent: 'bg-blue-100 text-blue-700',
  accepted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-600',
};

let draftKeyCounter = 0;
function nextDraftKey(): string {
  draftKeyCounter += 1;
  return `li-${draftKeyCounter}`;
}

function emptyLineItem(): LineItemDraft {
  return { key: nextDraftKey(), description: '', quantity: '1', unitPrice: '' };
}

function estimateToDrafts(estimate: Estimate | null): LineItemDraft[] {
  if (!estimate?.line_items?.length) return [emptyLineItem()];
  return estimate.line_items.map((li) => ({
    key: li.id || nextDraftKey(),
    description: li.description,
    quantity: String(li.quantity),
    unitPrice: (li.unit_price_minor / 100).toFixed(2),
  }));
}

export function EstimateEditor({
  accountId,
  accountName,
  projects,
  estimate,
  isNew,
  canManage,
  canSend,
}: EstimateEditorProps) {
  const router = useRouter();
  const editable = isNew || (estimate ? isEditable(estimate.status) : false);
  const canEdit = canManage && editable;

  // One idempotency key per create-session: safe retries, no duplicates.
  const [idempotencyKey] = useState(() =>
    isNew && typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : null,
  );

  const [title, setTitle] = useState(estimate?.title ?? '');
  const [projectId, setProjectId] = useState<string>(estimate?.project_id ?? 'none');
  const [currency, setCurrency] = useState(estimate?.currency ?? 'USD');
  const [taxRatePct, setTaxRatePct] = useState(
    estimate ? String(estimate.tax_rate_bps / 100) : '0',
  );
  const [validUntil, setValidUntil] = useState(estimate?.valid_until ?? '');
  const [notes, setNotes] = useState(estimate?.notes ?? '');
  const [lineItems, setLineItems] = useState<LineItemDraft[]>(() => estimateToDrafts(estimate));

  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState<EstimateStatus | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ---- Live totals preview (client-side mirror of server math) ----
  const totalsPreview = useMemo(() => {
    const items = lineItems
      .map((li) => {
        const qty = parseFloat(li.quantity);
        const priceMinor = majorToMinor(parseFloat(li.unitPrice || '0'));
        if (!Number.isFinite(qty) || qty <= 0 || priceMinor === null) return null;
        return { quantity: qty, unitPriceMinor: priceMinor };
      })
      .filter((x): x is { quantity: number; unitPriceMinor: number } => x !== null);

    const taxBps = Math.round((parseFloat(taxRatePct) || 0) * 100);
    try {
      return computeEstimateTotals({ lineItems: items, taxRateBps: taxBps });
    } catch {
      return null;
    }
  }, [lineItems, taxRatePct]);

  // ---- Line item helpers ----
  const updateLineItem = (key: string, patch: Partial<LineItemDraft>) => {
    setLineItems((prev) => prev.map((li) => (li.key === key ? { ...li, ...patch } : li)));
  };
  const addLineItem = () => setLineItems((prev) => [...prev, emptyLineItem()]);
  const removeLineItem = (key: string) =>
    setLineItems((prev) => (prev.length > 1 ? prev.filter((li) => li.key !== key) : prev));

  // ---- Validation (mirrors server rules for fast feedback) ----
  const validate = (): string | null => {
    if (!title.trim()) return 'Title is required';
    if (lineItems.length === 0) return 'At least one line item is required';
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      if (!li.description.trim()) return `Line item ${i + 1}: description is required`;
      const qty = parseFloat(li.quantity);
      if (!Number.isFinite(qty) || qty <= 0) return `Line item ${i + 1}: quantity must be > 0`;
      const price = parseFloat(li.unitPrice);
      if (!Number.isFinite(price) || price < 0) return `Line item ${i + 1}: unit price must be >= 0`;
    }
    return null;
  };

  const buildPayload = () => ({
    title: title.trim(),
    projectId: projectId === 'none' ? null : projectId,
    currency: currency.toUpperCase(),
    taxRateBps: Math.round((parseFloat(taxRatePct) || 0) * 100),
    validUntil: validUntil || null,
    notes: notes || null,
    lineItems: lineItems.map((li) => ({
      description: li.description.trim(),
      quantity: parseFloat(li.quantity),
      unitPriceMinor: majorToMinor(parseFloat(li.unitPrice || '0')) ?? 0,
    })),
  });

  // ---- Save (create or update draft) ----
  const handleSave = async () => {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      const url = isNew
        ? `/api/accounts/${accountId}/estimates`
        : `/api/accounts/${accountId}/estimates/${estimate!.id}`;
      const res = await apiFetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(isNew && idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save estimate');
        return;
      }
      toast.success(isNew ? 'Estimate created' : 'Estimate saved');
      if (isNew && data.estimate?.id) {
        router.replace(`/accounts/${accountId}/estimates/${data.estimate.id}`);
      } else {
        router.refresh();
      }
    } catch {
      toast.error('Failed to save estimate');
    } finally {
      setSaving(false);
    }
  };

  // ---- Lifecycle transition ----
  const handleTransition = async (toStatus: EstimateStatus) => {
    if (!estimate) return;
    setTransitioning(toStatus);
    try {
      const res = await apiFetch(
        `/api/accounts/${accountId}/estimates/${estimate.id}/transition`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toStatus }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Transition failed');
        return;
      }
      toast.success(`Estimate marked as ${toStatus}`);
      router.refresh();
    } catch {
      toast.error('Transition failed');
    } finally {
      setTransitioning(null);
    }
  };

  // ---- Soft delete ----
  const handleDelete = async () => {
    if (!estimate) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/accounts/${accountId}/estimates/${estimate.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to delete estimate');
        return;
      }
      toast.success('Estimate deleted');
      router.push(`/accounts/${accountId}/estimates`);
    } catch {
      toast.error('Failed to delete estimate');
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const readOnly = !canEdit;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-2"
            onClick={() => router.push(`/accounts/${accountId}/estimates`)}
          >
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to Estimates
          </Button>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">
              {isNew ? 'New Estimate' : estimate?.estimate_number || estimate?.title || 'Estimate'}
            </h1>
            {!isNew && estimate && (
              <Badge className={STATUS_STYLES[estimate.status]}>{estimate.status}</Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1">
            {isNew ? `Create a draft estimate for ${accountName}` : estimate?.title}
          </p>
        </div>

        {/* Lifecycle actions */}
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button onClick={handleSave} disabled={saving}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? 'Saving…' : isNew ? 'Create Estimate' : 'Save Changes'}
            </Button>
          )}
          {canSend && estimate?.status === 'draft' && (
            <Button
              variant="outline"
              onClick={() => handleTransition('sent')}
              disabled={transitioning !== null}
            >
              <Send className="mr-2 h-4 w-4" />
              {transitioning === 'sent' ? 'Sending…' : 'Mark as Sent'}
            </Button>
          )}
          {canSend && estimate?.status === 'sent' && (
            <>
              <Button
                variant="outline"
                className="text-green-700"
                onClick={() => handleTransition('accepted')}
                disabled={transitioning !== null}
              >
                {transitioning === 'accepted' ? 'Accepting…' : 'Accept'}
              </Button>
              <Button
                variant="outline"
                className="text-red-600"
                onClick={() => handleTransition('rejected')}
                disabled={transitioning !== null}
              >
                {transitioning === 'rejected' ? 'Rejecting…' : 'Reject'}
              </Button>
            </>
          )}
          {canManage && estimate?.status === 'draft' && (
            <Button
              variant="ghost"
              className="text-red-600 hover:text-red-700"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </Button>
          )}
        </div>
      </div>

      {readOnly && !isNew && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          This estimate is {estimate?.status} and can no longer be edited.
        </div>
      )}

      {/* Header fields */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Estimate Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={readOnly}
              placeholder="e.g. Website Redesign Phase 1"
            />
          </div>
          <div className="space-y-2">
            <Label>Project (optional)</Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={readOnly}>
              <SelectTrigger>
                <SelectValue placeholder="No project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No project</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="currency">Currency</Label>
            <Input
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
              disabled={readOnly}
              maxLength={3}
              placeholder="USD"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tax">Tax rate (%)</Label>
            <Input
              id="tax"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={taxRatePct}
              onChange={(e) => setTaxRatePct(e.target.value)}
              disabled={readOnly}
              placeholder="0"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="validUntil">Valid until</Label>
            <Input
              id="validUntil"
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              disabled={readOnly}
            />
          </div>
          <div className="space-y-2 sm:col-span-2 lg:col-span-3">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={readOnly}
              rows={3}
              placeholder="Terms, scope notes, payment schedule…"
            />
          </div>
        </CardContent>
      </Card>

      {/* Line items */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg">Line Items</CardTitle>
            <CardDescription>Quantities and prices are validated server-side</CardDescription>
          </div>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={addLineItem}>
              <Plus className="mr-1 h-4 w-4" /> Add Item
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {lineItems.map((li, idx) => {
            const qty = parseFloat(li.quantity);
            const priceMinor = majorToMinor(parseFloat(li.unitPrice || '0'));
            const lineTotal =
              Number.isFinite(qty) && qty > 0 && priceMinor !== null
                ? qty * priceMinor
                : null;
            return (
              <div key={li.key} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-12 space-y-1 sm:col-span-5">
                  <Label className="text-xs">Description</Label>
                  <Input
                    value={li.description}
                    onChange={(e) => updateLineItem(li.key, { description: e.target.value })}
                    disabled={readOnly}
                    placeholder="Service or product description"
                  />
                </div>
                <div className="col-span-4 space-y-1 sm:col-span-2">
                  <Label className="text-xs">Qty</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.001"
                    value={li.quantity}
                    onChange={(e) => updateLineItem(li.key, { quantity: e.target.value })}
                    disabled={readOnly}
                  />
                </div>
                <div className="col-span-4 space-y-1 sm:col-span-2">
                  <Label className="text-xs">Unit price ({currency})</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={li.unitPrice}
                    onChange={(e) => updateLineItem(li.key, { unitPrice: e.target.value })}
                    disabled={readOnly}
                    placeholder="0.00"
                  />
                </div>
                <div className="col-span-3 space-y-1 text-right sm:col-span-2">
                  <Label className="text-xs">Total</Label>
                  <div className="flex h-9 items-center justify-end font-medium">
                    {lineTotal !== null ? formatMinor(Math.round(lineTotal), currency) : '—'}
                  </div>
                </div>
                <div className="col-span-1 flex justify-end">
                  {canEdit && lineItems.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9 w-9 p-0 text-red-600 hover:text-red-700"
                      onClick={() => removeLineItem(li.key)}
                      aria-label={`Remove line item ${idx + 1}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Totals */}
      <Card>
        <CardContent className="pt-6">
          <div className="ml-auto max-w-xs space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-medium">
                {totalsPreview ? formatMinor(totalsPreview.subtotalMinor, currency) : '—'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                Tax ({taxRatePct || '0'}%)
              </span>
              <span className="font-medium">
                {totalsPreview ? formatMinor(totalsPreview.taxMinor, currency) : '—'}
              </span>
            </div>
            <div className="flex justify-between border-t pt-2 text-lg font-bold">
              <span>Total</span>
              <span>
                {totalsPreview ? formatMinor(totalsPreview.totalMinor, currency) : '—'}
              </span>
            </div>
            <p className="text-muted-foreground pt-1 text-right text-xs">
              Final totals are computed and validated on the server.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete estimate?</DialogTitle>
            <DialogDescription>
              &quot;{estimate?.title}&quot; will be soft-deleted. This cannot be undone from the UI.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
