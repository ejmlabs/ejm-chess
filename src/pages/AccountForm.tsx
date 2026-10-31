import type { FormEvent } from 'react';
import { Button } from '@ejm/ui/components/ui/button';
import { Input } from '@ejm/ui/components/ui/input';
import { AppActions, AppField, AppForm } from '@ejm/ui/layout/Application';
import { Text } from '@ejm/ui/layout/Text';
import type { PublicConfig } from '../client/api';
import Challenge from '../client/Challenge';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../password-policy';
import type { View } from './Account';

/** Credential controls load once the config and current session are known. */
export default function AccountForm({ view, title, config, returnTo, busy, username, email, password, token, resetToken, challengeKey, describedBy, hasError, changeView, onUsername, onEmail, onPassword, onToken, onSubmit }: {
  view: View;
  title: string;
  config: PublicConfig;
  returnTo: string | null;
  busy: boolean;
  username: string;
  email: string;
  password: string;
  token: string;
  resetToken: string;
  challengeKey: number;
  describedBy?: string;
  hasError: boolean;
  changeView(view: View): void;
  onUsername(value: string): void;
  onEmail(value: string): void;
  onPassword(value: string): void;
  onToken(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}) {
  const action = view === 'sign-up' ? 'sign-up' : view === 'sign-in' ? 'sign-in' : 'password-reset';
  return <>
    {view !== 'reset' && <AppActions role="group" aria-label="Account navigation">
      {view !== 'sign-in' && <Button variant="link" disabled={busy} onClick={() => changeView('sign-in')}>Sign in</Button>}
      {view !== 'sign-up' && <Button variant="link" disabled={busy} onClick={() => changeView('sign-up')}>Create account</Button>}
    </AppActions>}
    {returnTo?.includes('game=') && view !== 'reset' && <Text as="p">Your invitation is saved for after sign-in.</Text>}
    <AppForm aria-busy={busy} onSubmit={onSubmit}>
      {(view === 'sign-up' || view === 'sign-in') && <AppField>
        <label htmlFor="account-username">Username</label>
        <Input id="account-username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required minLength={3} maxLength={24} pattern="[A-Za-z0-9_]{3,24}" value={username} disabled={busy} onChange={event => onUsername(event.target.value)} aria-invalid={hasError} aria-describedby={[view === 'sign-up' && 'username-help', describedBy].filter(Boolean).join(' ') || undefined} />
        {view === 'sign-up' && <Text as="p" id="username-help" variant="muted">3 to 24 letters, numbers, or underscores. Usernames ignore case.</Text>}
      </AppField>}
      {(view === 'sign-up' || view === 'forgot') && <AppField>
        <label htmlFor="account-email">Recovery email{view === 'sign-up' ? ' (optional)' : ''}</label>
        <Input id="account-email" name="email" type="email" autoComplete="email" autoCapitalize="none" required={view === 'forgot'} maxLength={254} value={email} disabled={busy} onChange={event => onEmail(event.target.value)} aria-describedby={['email-help', describedBy].filter(Boolean).join(' ')} />
        <Text as="p" id="email-help" variant="muted">{view === 'sign-up' ? 'For verification and password recovery only, never marketing. Without it, you cannot reset a lost password.' : 'Use the recovery email from signup. Without one, email reset is unavailable.'}</Text>
      </AppField>}
      {view !== 'forgot' && <AppField>
        <label htmlFor="account-password">{view === 'reset' ? 'New password' : 'Password'}</label>
        <Input id="account-password" name={view === 'reset' ? 'newPassword' : 'password'} type="password" autoComplete={view === 'sign-in' ? 'current-password' : 'new-password'} required minLength={view === 'sign-in' ? undefined : MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} value={password} disabled={busy} onChange={event => onPassword(event.target.value)} aria-invalid={hasError} aria-describedby={[view !== 'sign-in' && 'password-help', describedBy].filter(Boolean).join(' ') || undefined} />
        {view !== 'sign-in' && <Text as="p" id="password-help" variant="muted">{MIN_PASSWORD_LENGTH} to {MAX_PASSWORD_LENGTH} characters. A long passphrase works well.</Text>}
      </AppField>}
      <Challenge key={`${action}-${challengeKey}`} config={config} action={action} onToken={onToken} />
      <div><Button type="submit" disabled={busy || !token || (view === 'reset' && !resetToken)}>{busy ? 'Please wait…' : view === 'forgot' ? 'Send reset link' : view === 'reset' ? 'Save new password' : title}</Button></div>
    </AppForm>
    {view === 'sign-in' && <div><Button variant="link" density="compact" disabled={busy} onClick={() => changeView('forgot')}>Forgot password?</Button></div>}
    {view === 'reset' && <div><Button variant="link" density="compact" disabled={busy} onClick={() => changeView('forgot')}>Request a new reset link</Button></div>}
    {(view === 'forgot' || view === 'reset') && config.local && <Text as="p" variant="muted">Email delivery is unavailable in this local preview.</Text>}
  </>;
}
