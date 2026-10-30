# Protected account and security-mail acceptance, 2026-10-21 UTC

## Tested boundary

The canonical private preview at `https://chess.ejmlabs.com` passed a real
account and security-email test with the owner-approved recipient. Full-host
Cloudflare Access and separate admin Access remained in force. The exact-path
budget webhook exception did not grant player or admin access.

The mail test used Worker version `[id in private provider record]`.
The frozen Worker bundle SHA256 was
`4d84f3382f9a1691d1cc611f447a83fed03419bdb51dcc6b5c695707ecc2596b`.
Wrangler deployed that bundle with `--no-bundle`; its prior dry run was
byte-identical. This records the tested source, not current working-tree
changes or public release.

## Observed results

- Synthetic username/password signup without a recovery email passed through
  the normal UI and live Turnstile check. The account page correctly showed no
  recovery email and unavailable email reset.
- A separate synthetic username/password signup with the approved recipient
  also passed through the normal UI and live challenge. Its email started
  unverified, without changing player eligibility.
- The verification request returned its generic receipt. The recipient
  confirmed actual inbox receipt and clicked the delivered link. The account
  page then showed a verified recovery email; a private aggregate readback
  confirmed one verified real-email account.
- A password-reset request used the normal recovery form and live challenge.
  The recipient confirmed receipt, entered and submitted the replacement
  password personally, then signed in with it. The agent neither entered nor
  retained the replacement password.
- Reloading the agent's earlier signed-in browser showed it signed out. The
  live aggregate readback showed one session for the verified account after
  the recipient's new sign-in. This supports old-session revocation at this
  boundary, rather than a claim about all possible reset races.
- Normal owner Operations authorization succeeded only after real email
  verification. Its versioned stop form restored all three persistent stops.
  The matching control and audit rows advanced from version 2 to version 3.
- The private allowance recorded exactly two email attempts. New game and
  analysis allowances stayed zero. No gameplay, rating or analysis work was
  admitted by the mail test.

Only the two operational tables were backed up for the email-only bootstrap.
No account, session or mail-body export was used. The backup was restricted to
the owner and the bootstrap retained its conditional version check and audit.
After verification, the application performed the subsequent stop change.

## Restored state

After the two sends, Worker version
`[id in private provider record]` restored the deployment-wide
`NEW_WORK_STOPPED=true` using the same exact Worker bundle. The provider
readback confirmed:

```text
LOCAL_DEV=false
NEW_WORK_STOPPED=true
MONTHLY_GAME_LIMIT=0
MONTHLY_EMAIL_LIMIT=20
MONTHLY_ANALYSIS_LIMIT=0
RANKED_ENABLED=false
TOURNAMENTS_ENABLED=false
ARENAS_ENABLED=false
AI_ENABLED=false
ANALYSIS_ENABLED=false
cpu_ms=50
```

Persistent control version 3 separately has games, email and analysis stopped.
The email counter remains 2. Stops preserve accepted link redemption, existing
results and recovery; they do not reset allowances or promise a hard invoice
cap. Public and ranked play remain closed.

## Retained evidence and limits

The private launch evidence includes the exact-bundle dry runs and deployments,
provider settings and aggregate readbacks, `owner-mail-bootstrap-cas-v2.sql`,
the operational-only backup, and screenshots of signup, verified email, reset
request and restored stops. Credentials, session cookies, email bodies,
verification links, private addresses and raw account rows are excluded from
this public report.

This test establishes delivery to one approved recipient. It does not prove
universal deliverability, abuse resistance under signup load, provider cost,
worldwide latency, live token-expiry/replay boundaries, two-player board
acceptance or complete backup restoration. Native tests separately cover
expiry, replay and revocation contracts. The remaining launch tasks stay open.
This source document does not establish publication of updated live guides.
