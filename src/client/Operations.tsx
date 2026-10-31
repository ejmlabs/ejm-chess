import { AppActions, AppField, AppFieldset, AppFlow, AppForm, AppGroup, AppHeading, AppPre, AppSection } from '@ejm/ui/layout/Application';
import { useState } from 'react';
import { Button } from '@ejm/ui/components/ui/button';
import { Checkbox } from '@ejm/ui/components/ui/checkbox';
import { Disclosure } from '@ejm/ui/components/ui/disclosure';
import { Select } from '@ejm/ui/components/ui/select';
import { Textarea } from '@ejm/ui/components/ui/textarea';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { Table } from '@ejm/ui/components/Table';
import { Status } from '@ejm/ui/layout/Status';
import { Text } from '@ejm/ui/layout/Text';
import { api } from './api';

interface Manifest { schema: string; createdAt: number; watermarks: Record<string, number>; repairInProgress: boolean; pendingResults: number }
interface ExportPage { kind: string; after: number; watermark: number; nextCursor: number | null; sha256: string; rows: unknown[] }
interface BudgetView {
  month: string;
  envelopeUsd: number;
  stoppedByEnv: boolean;
  control: { version: number; games_stopped: number; email_stopped: number; analysis_stopped: number };
  allowances: { kind: 'games' | 'email' | 'analysis'; used: number; accepting: boolean; denied: number }[];
  signup: { used: number; lifetimeUsed: number; accepting: boolean };
}
interface OperationsStatus { budget: BudgetView;[key: string]: unknown }
const budgetLabels = { games: 'New games', email: 'Account email', analysis: 'Server analysis' } as const;

function saveJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Operations() {
  const [status, setStatus] = useState<OperationsStatus | null>(null);
  const [stops, setStops] = useState({ gamesStopped: false, emailStopped: false, analysisStopped: false });
  const [stopReason, setStopReason] = useState('');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [page, setPage] = useState<ExportPage | null>(null);
  const [kind, setKind] = useState('results');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function loadStatus() {
    const next = await api<OperationsStatus>('/api/admin/operations');
    setStatus(next);
    setStops({
      gamesStopped: next.budget.control.games_stopped !== 0,
      emailStopped: next.budget.control.email_stopped !== 0, analysisStopped: next.budget.control.analysis_stopped !== 0
    });
    setStopReason('');
  }
  async function loadPage(after: number) {
    if (!manifest) return;
    const query = new URLSearchParams({ kind, after: String(after), watermark: String(manifest.watermarks[kind]) });
    setPage(await api<ExportPage>(`/api/admin/operations/export?${query}`));
  }
  return <Disclosure summary="Operations and rating journal export"><AppFlow>
    <Text as="p">Usage and stops, unsettled work, projection lag, and repair status. These counters do not establish measured capacity.</Text>
    {error && <StateBlock kind="error" message={error} />}{message && <div role="status"><Status status="info" label={message} /></div>}
    <AppActions><Button variant="secondary" disabled={busy} onClick={() => void run(loadStatus)}>Refresh status</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
        const result = await api<{ authority: { errors: string[] }; analysis: string }>('/api/admin/operations/maintenance', {});
        setMessage(`Maintenance completed. Authority errors: ${result.authority.errors.join(', ') || 'none'}. Analysis: ${result.analysis}.`);
        await loadStatus();
      })}>Retry pending work</Button></AppActions>
    {status !== null && <AppSection>
      <AppGroup as="header">
        <AppHeading as="h3">Spending target and usage</AppHeading>
        <Text as="p">Monthly spending target: ${status.budget.envelopeUsd}. Cloudflare budget alerts and the stop webhook are the economic limit. The table shows this deployment's usage for {status.budget.month}; it is not a capacity claim.</Text>
        <Text as="p" variant="muted">Feature switches and stops apply separately. Active games, accepted results, replay, and recovery continue when admission stops. These counters do not cap the Cloudflare invoice.</Text>
      </AppGroup>
      {status.budget.stoppedByEnv && <Status status="info" label="The deployment-wide stop is active. These controls cannot override it." />}
      <Table label="Monthly usage" caption={`Monthly usage for ${status.budget.month}`} truncate={false}
        columns={[{ key: 'kind', label: 'Work' }, { key: 'used', label: 'Used', align: 'right' },
        { key: 'denied', label: 'Denied', align: 'right' }, { key: 'state', label: 'State' }]}
        rows={[{ id: 'signup', kind: 'Signup attempts', used: status.budget.signup.used, denied: 0,
          state: status.budget.signup.accepting ? 'Available' : 'Stopped' }, ...status.budget.allowances.map(item => ({
          id: item.kind, kind: budgetLabels[item.kind], used: item.used, denied: item.denied,
          state: item.accepting ? 'Available' : 'Stopped'
        }))]} rowKey="id" rowHeader="kind" />
      <Text as="p" variant="muted">Lifetime signup attempts: {status.budget.signup.lifetimeUsed}. Failed and repeated attempts stay charged.</Text>
      <AppForm onSubmit={event => {
        event.preventDefault(); void run(async () => {
          await api('/api/admin/operations/budget', { expectedVersion: status.budget.control.version, ...stops, reason: stopReason });
          await loadStatus();
          setMessage('Budget stops saved. Existing games and accepted results continue.');
        });
      }}>
        <AppFieldset disabled={busy}>
          <legend>Stop new work</legend>
          <AppGroup>
            <Checkbox checked={stops.gamesStopped} label="Stop new accounts and games" onCheckedChange={value => setStops(current => ({ ...current, gamesStopped: value === true }))} />
            <Checkbox checked={stops.emailStopped} label="Stop account email" onCheckedChange={value => setStops(current => ({ ...current, emailStopped: value === true }))} />
            <Checkbox checked={stops.analysisStopped} label="Stop server analysis" onCheckedChange={value => setStops(current => ({ ...current, analysisStopped: value === true }))} />
          </AppGroup>
        </AppFieldset>
        <AppField>
          <label htmlFor="budget-stop-reason">Reason for this change</label>
          <Textarea id="budget-stop-reason" required minLength={10} maxLength={240} value={stopReason} disabled={busy} onChange={event => setStopReason(event.target.value)} />
        </AppField>
        <AppActions><Button type="submit" variant="secondary" disabled={busy || stopReason.trim().length < 10}>Save stops</Button></AppActions>
      </AppForm>
      <Text as="p" variant="muted">Cloudflare billing alerts cover account-wide usage, can arrive a day late, and exclude subscription fees. Other products, rejected traffic, and retained storage can still incur charges. Refresh status before changing stops.</Text>
      <Disclosure summary="Detailed operations counters"><AppPre>{JSON.stringify(status, null, 2)}</AppPre></Disclosure>
    </AppSection>}
    <AppSection>
      <AppGroup as="header">
        <AppHeading as="h3">Export the authority journal</AppHeading>
        <Text as="p">This exports accepted result and rating events with bounded pages and SHA-256 hashes. It excludes accounts, private review records, and live game storage. It is one part of recovery, and cannot restore the full service alone.</Text>
      </AppGroup>
      <AppActions><Button variant="secondary" disabled={busy} onClick={() => void run(async () => { setManifest(await api<Manifest>('/api/admin/operations/export/manifest')); setPage(null); })}>Capture export manifest</Button></AppActions>
      {manifest && <><Text as="p">Captured {new Date(manifest.createdAt).toLocaleString()}. {manifest.repairInProgress ? 'A repair is in progress. Repeat the export once it completes.' : 'No repair was in progress.'}</Text>
        <AppActions><Button variant="link" onClick={() => saveJson(manifest, `authority-${manifest.createdAt}-manifest.json`)}>Save manifest</Button></AppActions>
        <AppFlow>
          <AppField><label htmlFor="journal-kind">Journal</label><Select id="journal-kind" value={kind} disabled={busy} onChange={event => { setKind(event.target.value); setPage(null); }}>{Object.keys(manifest.watermarks).map(value => <option key={value} value={value}>{value} · watermark {manifest.watermarks[value]}</option>)}</Select></AppField>
          <AppActions><Button variant="secondary" disabled={busy} onClick={() => void run(() => loadPage(0))}>Read first page</Button></AppActions>
        </AppFlow>
        {page && <><Text as="p">{page.rows.length} events after cursor {page.after}. {page.nextCursor === null ? 'This journal is complete through its watermark.' : `Next cursor: ${page.nextCursor}. Save this page before reading the next.`}</Text><AppPre>SHA-256: {page.sha256}</AppPre>
          <AppActions><Button variant="secondary" onClick={() => saveJson(page, `authority-${manifest.createdAt}-${page.kind}-${page.after}.json`)}>Save page</Button>{page.nextCursor !== null && <Button variant="ghost" disabled={busy} onClick={() => void run(() => loadPage(page.nextCursor!))}>Read next page</Button>}</AppActions></>}
      </>}
    </AppSection>
  </AppFlow></Disclosure>;
}
