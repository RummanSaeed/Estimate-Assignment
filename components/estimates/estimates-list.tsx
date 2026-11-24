'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ArrowLeft, FileText, Plus, Search, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-config';
import { formatMinor } from '@/lib/estimate-money';
import type { Estimate, EstimateStatus } from '@/lib/estimate-service';

interface EstimatesListProps {
  accountId: string;
  accountName: string;
  canManage: boolean;
  canSend: boolean;
}

const STATUS_STYLES: Record<EstimateStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  sent: 'bg-blue-100 text-blue-700',
  accepted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-600',
};

const PAGE_SIZE = 25;

export function EstimatesList({ accountId, accountName, canManage }: EstimatesListProps) {
  const router = useRouter();
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Estimate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());

      const res = await apiFetch(`/api/accounts/${accountId}/estimates?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to load estimates');
        setEstimates([]);
        return;
      }
      setEstimates(data.estimates || []);
      setTotal(data.total || 0);
    } catch {
      toast.error('Failed to load estimates');
    } finally {
      setLoading(false);
    }
  }, [accountId, statusFilter, debouncedSearch, page]);

  // Debounce the search box so we don't fire a request per keystroke
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    // Defer so setLoading inside load() doesn't run synchronously in the effect
    const t = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch(
        `/api/accounts/${accountId}/estimates/${deleteTarget.id}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to delete estimate');
        return;
      }
      toast.success('Estimate deleted');
      setDeleteTarget(null);
      load();
    } catch {
      toast.error('Failed to delete estimate');
    } finally {
      setDeleting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-2"
            onClick={() => router.push(`/accounts/${accountId}`)}
          >
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to {accountName}
          </Button>
          <h1 className="text-3xl font-bold">Estimates</h1>
          <p className="text-muted-foreground mt-1">
            Proposals and estimates for {accountName}
          </p>
        </div>
        {canManage && (
          <Button onClick={() => router.push(`/accounts/${accountId}/estimates/new`)}>
            <Plus className="mr-2 h-4 w-4" /> New Estimate
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-3 h-4 w-4" />
            <Input
              placeholder="Search by title or number…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="accepted">Accepted</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileText className="h-5 w-5" /> All Estimates
          </CardTitle>
          <CardDescription>
            {total} estimate{total !== 1 ? 's' : ''} total
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : estimates.length === 0 ? (
            <div className="py-12 text-center">
              <FileText className="text-muted-foreground mx-auto mb-4 h-12 w-12" />
              <p className="text-muted-foreground">No estimates yet</p>
              {canManage && (
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => router.push(`/accounts/${accountId}/estimates/new`)}
                >
                  Create your first estimate
                </Button>
              )}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Valid Until</TableHead>
                    <TableHead className="w-[60px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {estimates.map((est) => (
                    <TableRow
                      key={est.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/accounts/${accountId}/estimates/${est.id}`)}
                    >
                      <TableCell className="font-mono text-sm">
                        {est.estimate_number || '—'}
                      </TableCell>
                      <TableCell className="font-medium">{est.title}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {est.project?.name || '—'}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_STYLES[est.status]}>{est.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatMinor(est.total_minor, est.currency)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-sm">
                        {est.valid_until || '—'}
                      </TableCell>
                      <TableCell>
                        {canManage && est.status === 'draft' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(est);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-4">
                  <p className="text-muted-foreground text-sm">
                    Page {page + 1} of {totalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 0}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page + 1 >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete estimate?</DialogTitle>
            <DialogDescription>
              &quot;{deleteTarget?.title}&quot; will be soft-deleted. This cannot be undone from the
              UI.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
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
