import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getCurrentUserProfileServer } from '@/lib/auth-server';
import { hasPermission } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { EstimateEditor } from '@/components/estimates/estimate-editor';
import type { Estimate } from '@/lib/estimate-service';

export const metadata: Metadata = {
  title: 'Estimate',
};

interface EstimateDetailPageProps {
  params: Promise<{ accountId: string; estimateId: string }>;
}

export default async function EstimateDetailPage({ params }: EstimateDetailPageProps) {
  const { accountId, estimateId } = await params;
  const isNew = estimateId === 'new';
  const userProfile = await getCurrentUserProfileServer();

  if (!userProfile) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground mt-2">Please log in to view estimates.</p>
        </div>
      </div>
    );
  }

  // Creating requires MANAGE; viewing an existing estimate requires VIEW.
  const requiredPermission = isNew ? Permission.MANAGE_ESTIMATES : Permission.VIEW_ESTIMATES;
  const canAccess = await hasPermission(userProfile, requiredPermission, { accountId });
  if (!canAccess) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground mt-2">
            You don&apos;t have permission to {isNew ? 'create' : 'view'} estimates for this
            account.
          </p>
        </div>
      </div>
    );
  }

  const [canManage, canSend] = await Promise.all([
    hasPermission(userProfile, Permission.MANAGE_ESTIMATES, { accountId }),
    hasPermission(userProfile, Permission.SEND_ESTIMATES, { accountId }),
  ]);

  const admin = createAdminSupabaseClient();
  if (!admin) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Database Error</h1>
          <p className="text-muted-foreground mt-2">Unable to connect to database.</p>
        </div>
      </div>
    );
  }

  // Account + projects for the editor's project picker
  const [{ data: account }, { data: projects }] = await Promise.all([
    admin.from('accounts').select('id, name').eq('id', accountId).maybeSingle(),
    admin
      .from('projects')
      .select('id, name')
      .eq('account_id', accountId)
      .neq('status', 'complete')
      .order('name'),
  ]);

  if (!account) {
    notFound();
  }

  let estimate: Estimate | null = null;
  if (!isNew) {
    const { data } = await admin
      .from('estimates')
      .select('*, line_items:estimate_line_items(*)')
      .eq('id', estimateId)
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .maybeSingle();
    estimate = (data as Estimate) || null;
    if (!estimate) {
      notFound();
    }
  }

  return (
    <EstimateEditor
      accountId={accountId}
      accountName={account.name}
      projects={(projects as { id: string; name: string }[]) || []}
      estimate={estimate}
      isNew={isNew}
      canManage={canManage}
      canSend={canSend}
    />
  );
}
