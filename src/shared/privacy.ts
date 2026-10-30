export const ACCOUNT_PRIVACY_POLICY = 'account-2026-10-v1' as const;
export const ACCOUNT_EXPORT_CATEGORIES = ['profile', 'reports', 'appeals', 'notices', 'games'] as const;
export type AccountExportCategory = typeof ACCOUNT_EXPORT_CATEGORIES[number];

export interface AccountExportRequest {
  password: string;
  category: AccountExportCategory;
  cursor?: string;
}

export interface AccountExportPage {
  policyVersion: typeof ACCOUNT_PRIVACY_POLICY;
  exportedAt: number;
  category: AccountExportCategory;
  records: Array<Record<string, unknown>>;
  nextCursor: string | null;
  atomicSnapshot: false;
}

export interface AccountClosureRequest {
  password: string;
  confirmation: 'CLOSE';
  requestId: string;
}

export interface AccountClosureReceipt {
  requestId: string;
  userId: string;
  policyVersion: typeof ACCOUNT_PRIVACY_POLICY;
  completedAt: number;
}
