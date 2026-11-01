import { AppActions, AppField, AppFieldset, AppFlow, AppForm, AppGroup, AppHeading, AppPre } from '@ejm/ui/layout/Application';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Button } from '@ejm/ui/components/ui/button';
import { Checkbox } from '@ejm/ui/components/ui/checkbox';
import { Disclosure } from '@ejm/ui/components/ui/disclosure';
import { Input } from '@ejm/ui/components/ui/input';
import { Select } from '@ejm/ui/components/ui/select';
import { Textarea } from '@ejm/ui/components/ui/textarea';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { Page } from '@ejm/ui/layout/Band';
import { Rule } from '@ejm/ui/layout/Rule';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Status } from '@ejm/ui/layout/Status';
import { Text } from '@ejm/ui/layout/Text';
import { api } from '../client/api';
import Operations from '../client/Operations';

const GameReplay = lazy(() => import('../client/GameReplay'));

interface Case { id: string; subjectId: string; gameId: string; status: string; version: number; updatedAt: number }
interface Evidence { id: string; game_id: string; kind: string; source_ref: string; source_version: string; summary_json: string; expires_at: number; hold_until: number }
interface Review {
  case: Case;
  reports: { id: string; reason: string; details: string; created_at: number }[];
  evidence: Evidence[];
  decisions: { id: string; outcome: string; reason: string; created_at: number }[];
  appeals: { id: string; status: string; reason: string }[];
  games: { id: string; whiteId: string; blackId: string | null; whiteName: string; blackName: string | null; pgn: string; plies: number; resultVersion: number; rulesVersion: string; reason: string; endedAt: number }[];
}

export default function Admin() {
  const [cases, setCases] = useState<Case[]>([]);
  const [olderPage, setOlderPage] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState('clear');
  const [reason, setReason] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [corroboration, setCorroboration] = useState('');
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [affectedGameIds, setAffectedGameIds] = useState<string[]>([]);
  const [appealId, setAppealId] = useState('');
  const [hours, setHours] = useState(24);
  const [confirmed, setConfirmed] = useState(false);
  const [voidGame, setVoidGame] = useState('');
  const [relatedGame, setRelatedGame] = useState('');
  const command = useRef<string | null>(null);
  const voidCommand = useRef<string | null>(null);
  async function loadCases(before?: Case) {
    const query = before ? `?${new URLSearchParams({ beforeAt: String(before.updatedAt), beforeId: before.id })}` : '';
    const data = await api<{ cases: Case[] }>(`/api/admin/cases${query}`);
    setCases(data.cases);
    setOlderPage(Boolean(before));
  }
  useEffect(() => { void loadCases().catch(reason => setError(reason.message)); }, []);

  async function open(id: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      setReview(await api<Review>(`/api/admin/cases/${encodeURIComponent(id)}`));
      setOutcome('clear'); setReason(''); setReviewNote(''); setCorroboration(''); setEvidenceIds([]); setAffectedGameIds([]); setAppealId(''); setRelatedGame(''); setConfirmed(false); command.current = null;
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  function changed() { command.current = null; setConfirmed(false); }
  function select(values: string[], id: string, checked: boolean) { return checked ? [...values, id] : values.filter(value => value !== id); }

  return <Page variant="application"><AppFlow as="section">
    <SectionHead purpose="application" as="h1" kicker="Private fair-play review" title="Review the evidence.">
      <Text as="p" variant="muted">Owner access and a verified account are required. Accuracy, shared networks, focus changes, and report counts cannot establish outside assistance.</Text>
    </SectionHead>
    {error && <StateBlock kind="error" message={error} />}{message && <div role="status"><Status status="info" label={message} /></div>}
    <AppFlow>
      <AppFlow as="section" aria-label="Cases">
        <AppGroup>
          <AppHeading as="h2">Cases</AppHeading>
          {!cases.length && !error && <StateBlock kind="empty" message="No cases on this page." />}
          {cases.length > 0 && <AppFlow as="ul">{cases.map(item => <AppGroup as="li" key={item.id}>
            <Button variant="link" disabled={busy} onClick={() => void open(item.id)}>{item.status.replaceAll('_', ' ')} · {item.gameId.slice(0, 8)}</Button>
            <Text variant="muted">{new Date(item.updatedAt).toLocaleDateString()}</Text><Rule />
          </AppGroup>)}</AppFlow>}
        </AppGroup>
        <AppActions><Button variant="ghost" disabled={busy} onClick={() => void loadCases().catch(reason => setError(reason.message))}>{olderPage ? 'Newest cases' : 'Refresh cases'}</Button>{cases.length === 20 && <Button variant="ghost" disabled={busy} onClick={() => { setBusy(true); void loadCases(cases.at(-1)).catch(reason => setError(reason.message)).finally(() => setBusy(false)); }}>Older cases</Button>}</AppActions>
      </AppFlow>
      {review && <AppFlow as="section">
        <AppGroup as="header">
          <AppHeading as="h2">Case {review.case.id.slice(0, 8)}</AppHeading>
          <Text as="p" variant="muted">Subject {review.case.subjectId} · version {review.case.version} · {review.case.status}</Text>
        </AppGroup>
        <AppFlow as="section">
          <AppHeading as="h3">Reports</AppHeading>
          {review.reports.length > 0 && <AppFlow>{review.reports.map(report => <AppGroup as="blockquote" key={report.id}><Text as="strong" variant="strong">{report.reason.replaceAll('-', ' ')}</Text><Text as="p">{report.details}</Text></AppGroup>)}</AppFlow>}
        </AppFlow>
        <AppFlow as="section">
          <AppHeading as="h3">Evidence</AppHeading>
          <AppFlow>
            {!review.evidence.length && <StateBlock kind="empty" message="No retained evidence is available; a restriction needs corroborated server evidence across more than one game." />}
            {review.evidence.map(item => <AppGroup key={item.id}><Rule /><Checkbox checked={evidenceIds.includes(item.id)} onCheckedChange={checked => { setEvidenceIds(select(evidenceIds, item.id, checked === true)); changed(); }} label={<Text>{item.kind.replaceAll('_', ' ')} · {item.game_id}</Text>} /><Text as="p" variant="muted">{item.source_ref} · {item.source_version}</Text><AppPre>{JSON.stringify(JSON.parse(item.summary_json), null, 2)}</AppPre><Text variant="muted">Retained through {new Date(Math.max(item.expires_at, item.hold_until)).toLocaleDateString()}</Text></AppGroup>)}
            <AppForm onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void api(`/api/admin/cases/${encodeURIComponent(review.case.id)}/evidence`, { gameId: relatedGame }).then(async () => { setReview(await api<Review>(`/api/admin/cases/${encodeURIComponent(review.case.id)}`)); setRelatedGame(''); changed(); setMessage('Server game evidence attached.'); }).catch(reason => setError(reason.message)).finally(() => setBusy(false)); }}>
              <AppField><label htmlFor="related-game">Add a completed game involving this player</label><Input id="related-game" required maxLength={100} value={relatedGame} onChange={event => setRelatedGame(event.target.value.trim())} /></AppField>
              <AppActions><Button type="submit" variant="secondary" disabled={busy}>Attach server record</Button></AppActions>
            </AppForm>
          </AppFlow>
        </AppFlow>
        <AppFlow as="section">
          <AppHeading as="h3">Recorded games</AppHeading>
          <AppFlow>
            {review.games.length === 0 && <StateBlock kind="empty" message="No retained game references." />}
            {review.games.map(game => <Disclosure key={game.id} summary={<>{game.whiteName} vs {game.blackName ?? 'No opponent'} · {game.id.slice(0, 8)}</>}><AppGroup><Text as="p" variant="muted">{game.plies} plies · {game.reason.replaceAll('-', ' ')} · result version {game.resultVersion} · {game.rulesVersion}</Text><Suspense fallback={<StateBlock kind="loading" message="Loading replay." skeleton={false} />}><GameReplay pgn={game.pgn} /></Suspense></AppGroup></Disclosure>)}
          </AppFlow>
        </AppFlow>
        <AppFlow as="section">
          <AppHeading as="h3">Appeals</AppHeading>
          <AppFlow>{!review.appeals.length && <StateBlock kind="empty" message="No appeals." />}{review.appeals.map(item => <AppGroup as="blockquote" key={item.id}><Text as="strong" variant="strong">{item.status}</Text><Text as="p">{item.reason}</Text></AppGroup>)}</AppFlow>
        </AppFlow>
        <AppFlow as="section">
          <AppHeading as="h3">Previous decisions</AppHeading>
          {!review.decisions.length && <StateBlock kind="empty" message="No decision recorded." />}
          {review.decisions.map(item => <Text as="p" key={item.id}>{item.outcome}: {item.reason}</Text>)}
        </AppFlow>
        <AppFlow as="section">
          <AppHeading as="h3">Record a decision</AppHeading>
          <AppForm onSubmit={event => { event.preventDefault(); if (busy || !confirmed) return; setBusy(true); setError(''); command.current ??= crypto.randomUUID(); void api<{ correction: string | null }>('/api/admin/decisions', { commandId: command.current, caseId: review.case.id, expectedVersion: review.case.version, outcome, reason, reviewNote, corroboration, evidenceIds, affectedGameIds: outcome === 'restrict' ? affectedGameIds : [], restrictionSeconds: hours * 3600, ...(appealId ? { appealId } : {}) }).then(async result => { setMessage(`Decision recorded.${result.correction ? ' Rating correction is pending.' : ''}`); setReview(null); command.current = null; await loadCases(); }).catch(reason => setError(reason.message)).finally(() => setBusy(false)); }}>
            <AppField><label htmlFor="decision-outcome">Outcome</label><Select id="decision-outcome" value={outcome} onChange={event => { setOutcome(event.target.value); changed(); }}><option value="clear">Clear the case</option><option value="restrict">Temporarily restrict ranked play</option><option value="overturn">Overturn an appealed decision</option><option value="uphold">Uphold an appealed decision</option></Select></AppField>
            {['uphold', 'overturn'].includes(outcome) && <AppField><label htmlFor="appeal-id">Pending appeal</label><Select id="appeal-id" required value={appealId} onChange={event => { setAppealId(event.target.value); changed(); }}><option value="">Select an appeal</option>{review.appeals.filter(item => item.status === 'pending').map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</Select></AppField>}
            <AppField><label htmlFor="decision-reason">Reason shown to the player</label><Textarea id="decision-reason" required minLength={10} maxLength={500} value={reason} onChange={event => { setReason(event.target.value); changed(); }} /></AppField>
            <AppField><label htmlFor="review-note">Private review notes</label><Textarea id="review-note" maxLength={4000} value={reviewNote} onChange={event => { setReviewNote(event.target.value); changed(); }} /></AppField>
            <AppField><label htmlFor="corroboration">Corroboration across games</label><Textarea id="corroboration" required={outcome === 'restrict' || outcome === 'uphold'} minLength={outcome === 'restrict' || outcome === 'uphold' ? 30 : 0} maxLength={4000} value={corroboration} onChange={event => { setCorroboration(event.target.value); changed(); }} /></AppField>
            {outcome === 'restrict' && <>
              <AppField><label htmlFor="restriction-hours">Restriction length in hours, from 1 to 168</label><Input id="restriction-hours" type="number" min={1} max={168} value={hours} onChange={event => { setHours(Number(event.target.value)); changed(); }} /></AppField>
              <AppFieldset><legend>Games to exclude from rating replay, if supported by evidence</legend><AppGroup><Text as="p" variant="muted">Leave all unchecked for an account restriction with no game correction.</Text>{[...new Set(review.evidence.map(item => item.game_id))].map(id => <Checkbox key={id} checked={affectedGameIds.includes(id)} onCheckedChange={checked => { setAffectedGameIds(select(affectedGameIds, id, checked === true)); changed(); }} label={<Text>{id}</Text>} />)}</AppGroup></AppFieldset>
            </>}
            <Checkbox checked={confirmed} required onCheckedChange={checked => setConfirmed(checked === true)} label="I reviewed the retained evidence and the player-visible reason." />
            <AppActions><Button type="submit" variant={outcome === 'restrict' ? 'danger' : 'primary'} disabled={busy || !confirmed}>{busy ? 'Recording…' : 'Record decision'}</Button></AppActions>
          </AppForm>
        </AppFlow>
      </AppFlow>}
    </AppFlow>
    <Operations />
    <Disclosure summary="Void a game still pending adjudication"><AppFlow><Text as="p">This closes a game saved under an earlier rules version that is still inside its 30-second adjudication wait, without awarding a win or changing ratings. The game authority records the decision ID.</Text><AppForm onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); voidCommand.current ??= crypto.randomUUID(); void api(`/api/admin/games/${encodeURIComponent(voidGame)}/void`, { decisionId: voidCommand.current }).then(() => { setMessage('Technical void recorded.'); voidCommand.current = null; setVoidGame(''); }).catch(reason => setError(reason.message)).finally(() => setBusy(false)); }}><AppField><label htmlFor="void-game">Game ID</label><Input id="void-game" required value={voidGame} onChange={event => { setVoidGame(event.target.value); voidCommand.current = null; }} /></AppField><AppActions><Button type="submit" variant="secondary" disabled={busy}>Record technical void</Button></AppActions></AppForm></AppFlow></Disclosure>
  </AppFlow></Page>;
}
