import { Link } from '@ejm/ssg';
import { Button } from '@ejm/ui/components/ui/button';
import { Disclosure } from '@ejm/ui/components/ui/disclosure';
import { Input } from '@ejm/ui/components/ui/input';
import { AppActions, AppField, AppFlow, AppForm } from '@ejm/ui/layout/Application';
import { Text } from '@ejm/ui/layout/Text';
import { api, type Me, type PublicConfig } from '../client/api';
import Challenge from '../client/Challenge';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../password-policy';
import AccountPrivacy from './AccountPrivacy';

/** Account settings load only after the current session has been checked. */
export default function AccountSession({ me, config, returnTo, busy, username, password, token, challengeKey, describedBy, onUsername, onPassword, onToken, run, refreshIdentity, onMessage, onSignedOut }: {
  me: Me;
  config: PublicConfig;
  returnTo: string | null;
  busy: boolean;
  username: string;
  password: string;
  token: string;
  challengeKey: number;
  describedBy?: string;
  onUsername(value: string): void;
  onPassword(value: string): void;
  onToken(value: string): void;
  run(action: () => Promise<void>): Promise<void>;
  refreshIdentity(): Promise<void>;
  onMessage(message: string): void;
  onSignedOut(): void;
}) {
  const complete = !me.isAnonymous && !me.accountReady;
  const action = complete ? 'account-complete' : 'verify-email';

  return <>
    <Text as="p">Signed in as <strong>{me.isAnonymous ? 'a legacy guest' : me.username ?? me.name}</strong>.</Text>
    {me.isAnonymous ? <>
      <Text as="p">You can resume games already owned by this browser and replay their records. New games require a username and password account.</Text>
      <Text as="p" variant="muted">Signing out loses this guest session. Keep this browser session if you still need its games.</Text>
    </> : complete ? <>
      <Text as="p">Set a username and password to start new games. Your existing games and records stay with this account.</Text>
      <AppForm aria-busy={busy} onSubmit={event => {
        event.preventDefault();
        if (!token) return;
        void run(async () => {
          await api('/api/account/complete', { username: username.trim().toLowerCase(), password }, token);
          await refreshIdentity();
        });
      }}>
        <AppField><label htmlFor="account-username">Username</label>
          <Input id="account-username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required minLength={3} maxLength={24} pattern="[A-Za-z0-9_]{3,24}" value={username} disabled={busy} onChange={event => onUsername(event.target.value)} aria-describedby={['username-help', describedBy].filter(Boolean).join(' ')} />
          <Text as="p" id="username-help" variant="muted">3 to 24 letters, numbers, or underscores. Usernames ignore case.</Text></AppField>
        <AppField><label htmlFor="account-password">Password</label>
          <Input id="account-password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} value={password} disabled={busy} onChange={event => onPassword(event.target.value)} aria-describedby={['password-help', describedBy].filter(Boolean).join(' ')} />
          <Text as="p" id="password-help" variant="muted">{MIN_PASSWORD_LENGTH} to {MAX_PASSWORD_LENGTH} characters. A long passphrase works well.</Text></AppField>
        <Challenge key={`${action}-${challengeKey}`} config={config} action={action} onToken={onToken} />
        <div><Button type="submit" disabled={busy || !token}>{busy ? 'Saving…' : 'Finish account'}</Button></div>
      </AppForm>
    </> : <>
      <Text as="p">{!me.hasRecoveryEmail ? 'No recovery email is set. Email password reset is unavailable. You cannot add or change recovery email in this preview.' : me.emailVerified ? 'Your recovery email is verified.' : 'Your recovery email is unverified. Verification is optional and does not affect play.'}</Text>
      {me.hasRecoveryEmail && !me.emailVerified && <Disclosure summary="Verify recovery email">
        <AppFlow>
          <Text as="p">Send a link to confirm the private recovery email you used at signup. Password reset can use this address before verification.</Text>
          <AppForm aria-busy={busy} onSubmit={event => { event.preventDefault(); if (!token) return; void run(async () => { await api('/api/auth/send-verification-email', {}, token); onMessage('If delivery is available, a verification link will arrive shortly.'); }); }}>
            <Challenge key={`${action}-${challengeKey}`} config={config} action="verify-email" onToken={onToken} />
            <div><Button type="submit" disabled={busy || !token}>{busy ? 'Sending…' : 'Send verification link'}</Button></div>
          </AppForm>
          {config.local && <Text as="p" variant="muted">Email delivery is unavailable in this local preview.</Text>}
        </AppFlow>
      </Disclosure>}
      <AppActions><Button asChild><Link href={returnTo ?? '/play/'}>Go to Play</Link></Button><Button asChild variant="ghost"><Link href="/history/">Your games</Link></Button></AppActions>
      <AccountPrivacy busy={busy} run={run} onMessage={onMessage} onClosed={onSignedOut} />
    </>}
    <Disclosure summary="Sign out">
      <AppFlow>
        <Text as="p">Finish any active game or tournament reservation before changing sign-in.</Text>
        <AppActions><Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
          await api('/api/auth/sign-out', {});
          onSignedOut(); onMessage('You are signed out.');
        })}>{busy ? 'Signing out…' : me.isAnonymous ? 'Sign out of guest session' : 'Sign out'}</Button></AppActions>
      </AppFlow>
    </Disclosure>
  </>;
}
