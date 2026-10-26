import { AppSection } from '@ejm/ui/layout/Application';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import { Page } from '@ejm/ui/layout/Band';
import { SectionHead } from '@ejm/ui/layout/SectionHead';
import { Text } from '@ejm/ui/layout/Text';
import { api, type Me, type PublicConfig } from '../client/api';
import { playReturnPath } from '../client/accountPath';

const AccountForm = lazy(() => import('./AccountForm'));
const AccountSession = lazy(() => import('./AccountSession'));

export type View = 'sign-in' | 'sign-up' | 'forgot' | 'reset';
const titles: Record<View, string> = { 'sign-in': 'Sign in', 'sign-up': 'Create account', forgot: 'Reset password', reset: 'Choose a new password' };

export default function Account() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>('sign-in');
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [challengeKey, setChallengeKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const pending = useRef(false);
  const errorElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    setReturnTo(playReturnPath(query.get('returnTo')));
    if (query.has('reset')) {
      const value = query.get('reset') ?? '';
      // Keep the one-use secret in page memory only, and remove it before other work.
      history.replaceState(null, '', '/account/');
      setView('reset');
      if (value && value.length <= 512) setResetToken(value);
      else setError('This password reset link is invalid. Request a new link.');
    } else if (query.get('view') === 'sign-up') setView('sign-up');
    if (query.has('error')) setError('This account link could not be used. Request a new link.');
    let current = true;
    void Promise.all([api<PublicConfig>('/api/config'), api<Me | null>('/api/me')])
      .then(([value, actor]) => {
        if (!current) return;
        setConfig(value); setMe(actor); setLoaded(true);
        if (query.get('verified') === '1' && actor?.hasRecoveryEmail && actor.emailVerified) setMessage('Your recovery email is verified.');
      })
      .catch(() => { if (current) { setLoaded(true); setError('Your account could not be loaded. Reload to try again.'); } });
    return () => { current = false; };
  }, []);

  useEffect(() => { if (error) errorElement.current?.focus(); }, [error]);

  function changeView(next: View) {
    if (pending.current) return;
    setView(next); setPassword(''); setResetToken(''); setError(''); setMessage('');
    setToken(''); setChallengeKey(value => value + 1);
  }

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'This request failed. Try again.'); }
    finally {
      pending.current = false; setBusy(false); setPassword('');
      setToken(''); setChallengeKey(value => value + 1);
    }
  }

  async function refreshIdentity() {
    const actor = await api<Me | null>('/api/me');
    if (!actor || actor.isAnonymous) throw new Error('Sign-in could not be confirmed. Try again.');
    setMe(actor);
    setUsername(''); setEmail('');
    if (actor.accountReady && returnTo) location.assign(returnTo);
    else setMessage(actor.accountReady ? 'You are signed in.' : 'Choose a username and password to finish your account.');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !config) return;
    void run(async () => {
      if (view === 'forgot') {
        await api('/api/auth/request-password-reset', { email: email.trim() }, token);
        setEmail('');
        setMessage('If this email has an account and delivery is available, a password reset link will arrive shortly.');
      } else if (view === 'reset') {
        if (!resetToken) throw new Error('This password reset link is invalid. Request a new link.');
        await api('/api/auth/reset-password', { token: resetToken, newPassword: password }, token);
        setResetToken(''); setPassword('');
        let actor: Me | null;
        try { actor = await api<Me | null>('/api/me'); }
        catch {
          setConfig(null);
          throw new Error('The password was reset, but your current sign-in could not be checked. Reload to continue.');
        }
        setMe(actor); setView('sign-in'); setUsername(''); setEmail('');
        setMessage(actor
          ? `The password was reset. This browser is signed in as ${actor.isAnonymous ? 'a legacy guest' : actor.username ?? actor.name}.`
          : 'The password was reset and that account’s sessions were closed. Sign in with the new password.');
      } else {
        const normalized = username.trim().toLowerCase();
        if (view === 'sign-up') await api('/api/auth/sign-up/email', { username: normalized, ...(email.trim() ? { email: email.trim() } : {}), password, name: normalized }, token);
        else await api('/api/auth/sign-in/username', { username: normalized, password }, token);
        await refreshIdentity();
      }
    });
  }

  const accountView = Boolean(me && view !== 'reset');
  const describedBy = error ? 'account-error' : undefined;

  return <Page variant="application"><AppSection aria-labelledby="account-heading">
    <SectionHead purpose="application" as="h1" id="account-heading" title={accountView ? 'Your account' : titles[view]} />
    {!loaded && <StateBlock kind="loading" density="compact" skeleton={false} message="Loading your account." />}
    {error && <div id="account-error" ref={errorElement} tabIndex={-1}><StateBlock kind="error" density="compact" message={error} /></div>}
    {message && <Text as="p" role="status">{message}</Text>}
    {loaded && config && <>
      {accountView && me ? <Suspense fallback={<StateBlock kind="loading" density="compact" skeleton={false} message="Loading account settings." />}>
        <AccountSession me={me} config={config} returnTo={returnTo} busy={busy} username={username} password={password} token={token} challengeKey={challengeKey} describedBy={describedBy} onUsername={setUsername} onPassword={setPassword} onToken={setToken} run={run} refreshIdentity={refreshIdentity} onMessage={setMessage} onSignedOut={() => { setMe(null); setView('sign-in'); setUsername(''); setEmail(''); }} />
      </Suspense> : <Suspense fallback={<StateBlock kind="loading" density="compact" skeleton={false} message="Loading account controls." />}>
        <AccountForm view={view} title={titles[view]} config={config} returnTo={returnTo} busy={busy} username={username} email={email} password={password} token={token} resetToken={resetToken} challengeKey={challengeKey} describedBy={describedBy} hasError={Boolean(error)} changeView={changeView} onUsername={setUsername} onEmail={setEmail} onPassword={setPassword} onToken={setToken} onSubmit={submit} />
      </Suspense>}
    </>}
  </AppSection></Page>;
}
