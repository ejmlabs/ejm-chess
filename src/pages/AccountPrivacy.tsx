import { useEffect, useRef, useState } from 'react';
import { Link } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { Disclosure } from '@ejm/ui/components/ui/disclosure';
import { Input } from '@ejm/ui/components/ui/input';
import { Select } from '@ejm/ui/components/ui/select';
import { AppActions, AppField, AppForm } from '@ejm/ui/layout/Application';
import { Text } from '@ejm/ui/layout/Text';
import { api } from '../client/api';
import { ACCOUNT_EXPORT_CATEGORIES, type AccountExportCategory, type AccountExportPage, type AccountClosureReceipt } from '../shared/privacy';

const exportLabels: Record<AccountExportCategory, string> = { profile: 'Profile and recovery information', reports: 'Your reports', appeals: 'Your appeals', notices: 'Your notices', games: 'Your games' };

/** Authenticated data controls stay out of the sign-in page's initial load. */
export default function AccountPrivacy({ busy, run, onMessage, onClosed }: {
  busy: boolean;
  run(action: () => Promise<void>): Promise<void>;
  onMessage(message: string): void;
  onClosed(): void;
}) {

  const [exportCategory, setExportCategory] = useState<AccountExportCategory>('profile');
  const [exportPassword, setExportPassword] = useState('');
  const [exportCursor, setExportCursor] = useState<string | null>(null);
  const [exportPage, setExportPage] = useState(0);
  const [closurePassword, setClosurePassword] = useState('');
  const [closureConfirmation, setClosureConfirmation] = useState('');
  const closureRequestId = useRef<string | null>(null);

  // Any account request clears entered passwords, including requests elsewhere on the page.
  useEffect(() => {
    if (!busy) { setExportPassword(''); setClosurePassword(''); }
  }, [busy]);

  return <>
    <Disclosure summary="Download account data">
      <AppForm aria-busy={busy} onSubmit={event => {
        event.preventDefault();
        if (exportPage > 0 && !exportCursor) return;
        void run(async () => {
          const page = await api<AccountExportPage>('/api/account/export', { password: exportPassword, category: exportCategory, ...(exportCursor ? { cursor: exportCursor } : {}) });
          const url = URL.createObjectURL(new Blob([JSON.stringify(page)], { type: 'application/json' }));
          const download = document.createElement('a');
          download.href = url; download.download = `chess-${exportCategory}-${exportPage + 1}.json`;
          document.body.append(download); download.click(); download.remove();
          setTimeout(() => URL.revokeObjectURL(url), 0);
          setExportCursor(page.nextCursor); setExportPage(value => value + 1);
          onMessage(page.nextCursor ? 'This page was downloaded. Confirm your password again to download the next page.' : 'The last page in this category was downloaded.');
        });
      }}>
        <Text as="p">Download your own data as JSON, up to 50 records per page. Pages may reflect different moments. Game pages link to your PGN downloads.</Text>
        <AppField><label htmlFor="account-export-category">Data to download</label>
          <Select id="account-export-category" value={exportCategory} disabled={busy} onChange={event => {
            const category = ACCOUNT_EXPORT_CATEGORIES.find(value => value === event.target.value);
            if (category) { setExportCategory(category); setExportCursor(null); setExportPage(0); setExportPassword(''); onMessage(''); }
          }}>{ACCOUNT_EXPORT_CATEGORIES.map(category => <option key={category} value={category}>{exportLabels[category]}</option>)}</Select>
        </AppField>
        <AppField><label htmlFor="account-export-password">Current password</label>
          <Input id="account-export-password" name="password" type="password" autoComplete="current-password" required maxLength={128} value={exportPassword} disabled={busy || (exportPage > 0 && !exportCursor)} onChange={event => setExportPassword(event.target.value)} />
        </AppField>
        <AppActions><Button type="submit" variant="secondary" disabled={busy || !exportPassword || (exportPage > 0 && !exportCursor)}>{busy ? 'Preparing…' : exportPage > 0 ? 'Download next page' : 'Download JSON'}</Button>
          {exportPage > 0 && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setExportCursor(null); setExportPage(0); setExportPassword(''); onMessage(''); }}>Start this category again</Button>}
        </AppActions>
        <Text as="p" variant="muted">Keep downloaded files private. Passwords, session tokens, reviewer notes and other players’ private data are excluded. <Link href="/privacy/">Privacy and retention</Link></Text>
      </AppForm>
    </Disclosure>
    <Disclosure summary="Close account">
      <AppForm aria-busy={busy} onSubmit={event => {
        event.preventDefault();
        if (closureConfirmation !== 'CLOSE') return;
        void run(async () => {
          closureRequestId.current ??= crypto.randomUUID();
          await api<AccountClosureReceipt>('/api/account/close', { password: closurePassword, confirmation: 'CLOSE', requestId: closureRequestId.current });
          setClosureConfirmation(''); onClosed();
          setExportCursor(null); setExportPage(0); closureRequestId.current = null;
          onMessage('Your account is closed. Your credentials, sessions and recovery email were removed. Game and rating history remain.');
        });
      }}>
        <Text as="p">This permanently removes your sign-in credentials, sessions, recovery email and current profile details. Download wanted data and PGNs first. You will lose access to this account.</Text>
        <Text as="p">Game records, historical player names, rating corrections and minimal audit records remain. Finish active games and leave events before closing. An unpaired ranked queue entry can be cancelled during closure.</Text>
        <AppField><label htmlFor="account-close-password">Current password</label>
          <Input id="account-close-password" name="password" type="password" autoComplete="current-password" required maxLength={128} value={closurePassword} disabled={busy} onChange={event => setClosurePassword(event.target.value)} />
        </AppField>
        <AppField><label htmlFor="account-close-confirmation">Type CLOSE to confirm</label>
          <Input id="account-close-confirmation" autoComplete="off" autoCapitalize="characters" spellCheck={false} required pattern="CLOSE" maxLength={5} value={closureConfirmation} disabled={busy} onChange={event => setClosureConfirmation(event.target.value)} />
        </AppField>
        <div><Button type="submit" variant="danger" disabled={busy || !closurePassword || closureConfirmation !== 'CLOSE'}>{busy ? 'Closing…' : 'Close account permanently'}</Button></div>
      </AppForm>
    </Disclosure>
  </>;
}
