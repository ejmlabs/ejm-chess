export const ACCOUNT_PRIVACY_POLICY = 'account-2026-10-v1' as const;
export const ACCOUNT_EXPORT_CATEGORIES = ['profile', 'reports', 'appeals', 'notices', 'games'] as const;
export type AccountExportCategory = typeof ACCOUNT_EXPORT_CATEGORIES[number];

export interface AccountExportPage {
  policyVersion: typeof ACCOUNT_PRIVACY_POLICY;
  exportedAt: number;
  category: AccountExportCategory;
  records: Array<Record<string, unknown>>;
  nextCursor: string | null;
  atomicSnapshot: false;
}

export interface AccountClosureReceipt {
  requestId: string;
  userId: string;
  policyVersion: typeof ACCOUNT_PRIVACY_POLICY;
  completedAt: number;
}
