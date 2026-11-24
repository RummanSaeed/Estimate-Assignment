/**
 * Account Kanban Config Service
 *
 * Client-side service for account-specific kanban column configuration.
 * Kanban/Gantt views for projects are deprecated (workflows replace them),
 * so this service provides stable defaults and status<->column mapping
 * used by the remaining "Move Project" dialog in the account overview.
 */

export interface KanbanColumn {
  id: string;
  name: string;
  color: string;
  order: number;
  /** Project status this column represents (when known) */
  status?: string;
}

export interface AccountKanbanConfig {
  account_id: string;
  columns: KanbanColumn[];
}

const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'planned', name: 'Planned', color: '#6B7280', order: 1, status: 'planning' },
  { id: 'in-progress', name: 'In Progress', color: '#3B82F6', order: 2, status: 'in_progress' },
  { id: 'review', name: 'Review', color: '#F59E0B', order: 3, status: 'review' },
  { id: 'complete', name: 'Complete', color: '#10B981', order: 4, status: 'complete' },
];

const COLUMN_ID_TO_STATUS: Record<string, string> = {
  planned: 'planning',
  'in-progress': 'in_progress',
  review: 'review',
  complete: 'complete',
};

const STATUS_TO_COLUMN_ID: Record<string, string> = {
  planning: 'planned',
  in_progress: 'in-progress',
  review: 'review',
  complete: 'complete',
  on_hold: 'planned',
};

class AccountKanbanConfigService {
  async getOrCreateAccountKanbanConfig(accountId: string): Promise<AccountKanbanConfig> {
    return {
      account_id: accountId,
      columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
    };
  }

  getStatusForKanbanColumn(columnId: string, columns: KanbanColumn[]): string {
    const column = columns.find((c) => c.id === columnId);
    if (column?.status) return column.status;
    return COLUMN_ID_TO_STATUS[columnId] || 'planning';
  }

  getKanbanColumnForStatus(status: string, columns: KanbanColumn[]): string {
    const column = columns.find((c) => c.status === status);
    if (column) return column.id;
    return STATUS_TO_COLUMN_ID[status] || 'planned';
  }
}

export const accountKanbanConfigService = new AccountKanbanConfigService();
