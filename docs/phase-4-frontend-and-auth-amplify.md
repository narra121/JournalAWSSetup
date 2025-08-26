# Phase 4 – Frontend and Authentication (Amplify)

Goal: Connect an existing frontend to the deployed backend and Cognito auth without recreating resources.

## Initialize Amplify in Frontend

From your frontend project root:

```powershell
amplify init
```

## Import Existing Cognito Auth

```powershell
amplify import auth
# Select the Cognito User Pool created by SAM
```

Generates/updates `aws-exports.js` with User Pool and App Client IDs.

## Install Client Libraries

```powershell
npm install aws-amplify @aws-amplify/ui-react
```

## Configure Amplify (React example)

- In `src/main.tsx` or `src/index.tsx`:

```ts
import { Amplify } from 'aws-amplify';
import awsconfig from './aws-exports';
Amplify.configure(awsconfig);
```

- Wrap app with `<Authenticator>`:

```tsx
import { Authenticator } from '@aws-amplify/ui-react';

export default function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <>
          <button onClick={signOut}>Sign out</button>
          {/* your app */}
        </>
      )}
    </Authenticator>
  );
}
```

## Call Your API (authenticated)

- Add the API base URL from SAM outputs to your config (e.g., `aws-exports.js` custom field or app env var)
- Use `fetch` with `Authorization` header set to the Cognito ID token, or use Amplify API category if configured

```ts
import { fetchAuthSession } from 'aws-amplify/auth';

export async function apiGet(path: string) {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  const res = await fetch(`${import.meta.env.VITE_API_BASE}${path}`, {
    headers: { Authorization: idToken ?? '' },
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}
```

## Next

Automate deployments in [Phase 5 – CI/CD](./phase-5-ci-cd.md).
