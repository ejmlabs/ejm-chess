import { useEffect, useRef, useState } from 'react';
import { StateBlock } from '@ejm/ui/components/StateBlock';
import type { PublicConfig } from './api';

interface Turnstile {
  render(element: HTMLElement, options: { sitekey: string; action: string; callback(token: string): void; 'expired-callback'(): void; 'error-callback'(): void; theme: string }): string;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: Turnstile } }
let loading: Promise<Turnstile> | null = null;
function load() {
  if (!loading) loading = new Promise<Turnstile>((resolve, reject) => {
    if (window.turnstile) { resolve(window.turnstile); return; }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Challenge unavailable'));
    script.onerror = () => { loading = null; reject(new Error('Challenge unavailable')); };
    document.head.appendChild(script);
  });
  return loading;
}

export default function Challenge({ config, action, onToken }: { config: PublicConfig; action: 'sign-up' | 'sign-in' | 'password-reset' | 'verify-email' | 'account-complete' | 'report'; onToken(token: string): void }) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const callback = useRef(onToken);
  callback.current = onToken;
  useEffect(() => {
    if (config.local) { callback.current('local-development'); return; }
    if (!config.turnstileSiteKey) { setError('The security check is unavailable. Try again later.'); return; }
    let cancelled = false;
    let widget: string | undefined;
    void load().then(turnstile => {
      if (cancelled || !element.current) return;
      widget = turnstile.render(element.current, {
        sitekey: config.turnstileSiteKey!, action, theme: 'auto',
        callback: token => callback.current(token),
        'expired-callback': () => callback.current(''),
        'error-callback': () => { callback.current(''); setError('The security check could not load. Reload to try again.'); },
      });
    }).catch(() => setError('The security check could not load. Reload to try again.'));
    return () => { cancelled = true; if (widget) window.turnstile?.remove(widget); };
  }, [config.local, config.turnstileSiteKey, action]);
  if (config.local) return null;
  return <><div ref={element} />{error && <StateBlock kind="error" message={error} density="compact" />}</>;
}
