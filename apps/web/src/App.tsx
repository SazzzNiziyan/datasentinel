import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AppShell } from './app/AppShell.tsx';
import { primaryNav, secondaryNav } from './app/navigation.ts';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { PendingPage } from './pages/PendingPage.tsx';

// Development-only token preview. Loaded lazily inside the DEV check so that
// production builds drop its code and its CSS entirely.
const TokenSpecimen = import.meta.env.DEV
  ? lazy(() => import('./TokenSpecimen.tsx').then((m) => ({ default: m.TokenSpecimen })))
  : null;

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          {[...primaryNav, ...secondaryNav].map((item) => (
            <Route key={item.path} path={item.path} element={<PendingPage item={item} />} />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        {TokenSpecimen !== null && (
          <Route
            path="/dev/tokens"
            element={
              <Suspense>
                <TokenSpecimen />
              </Suspense>
            }
          />
        )}
      </Routes>
    </BrowserRouter>
  );
}
