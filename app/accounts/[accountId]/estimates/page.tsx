import { Metadata } from 'next';
import { getCurrentUserProfileServer } from '@/lib/auth-server';
import { hasPermission } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { EstimatesList } from '@/components/estimates/estimates-list';

export const metadata: Metadata = {
  title: 'Estimates',
};

interface EstimatesPageProps {
  params: Promise<{ accountId: string }>;
}

export default async function AccountEstimatesPage({ params }: EstimatesPageProps) {
  const { accountId } = await params;
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

  // View permission with account context (hasAccountAccess is enforced inside)
  const canView = await hasPermission(userProfile, Permission.VIEW_ESTIMATES, { accountId });
  if (!canView) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground mt-2">
            You don&apos;t have permission to view estimates for this account.
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
  let accountName = 'Account';
  if (admin) {
    const { data: account } = await admin
      .from('accounts')
      .select('name')
      .eq('id', accountId)
      .maybeSingle();
    if (account?.name) accountName = account.name;
  }

  return (
    <EstimatesList
      accountId={accountId}
      accountName={accountName}
      canManage={canManage}
      canSend={canSend}
    />
  );
}
