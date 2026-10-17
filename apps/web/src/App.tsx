import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AppShell } from './app/AppShell.tsx';
import { RequireSession } from './app/RequireSession.tsx';
import { SessionProvider } from './app/SessionProvider.tsx';
import { primaryNav, secondaryNav } from './app/navigation.ts';
import { LoadingState } from './components/LoadingState.tsx';
import { DatasetsPage } from './pages/DatasetsPage.tsx';
import { IncidentsPage } from './pages/IncidentsPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { PendingPage } from './pages/PendingPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { InvitePage } from './pages/InvitePage.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { SourcesPage } from './pages/SourcesPage.tsx';

/** Built screens by path; the rest show a "not built yet" page. */
const screens: Record<string, ReactNode> = {
  '/': <OverviewPage />,
  '/incidents': <IncidentsPage />,
  '/sources': <SourcesPage />,
  '/datasets': <DatasetsPage />,
  '/settings': <SettingsPage />,
};

// Development-only previews. Loaded lazily inside the DEV check so that
// production builds drop their code and CSS entirely.
const TokenSpecimen = import.meta.env.DEV
  ? lazy(() => import('./dev/TokenSpecimen.tsx').then((m) => ({ default: m.TokenSpecimen })))
  : null;
const ComponentGallery = import.meta.env.DEV
  ? lazy(() => import('./dev/ComponentGallery.tsx').then((m) => ({ default: m.ComponentGallery })))
  : null;

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route
            element={
              <RequireSession>
                <AppShell />
              </RequireSession>
            }
          >
            {[...primaryNav, ...secondaryNav].map((item) => (
              <Route
                key={item.path}
                path={item.path}
                element={screens[item.path] ?? <PendingPage item={item} />}
              />
            ))}
            {ComponentGallery !== null && (
              <Route
                path="/dev/components"
                element={
                  <Suspense
                    fallback={
                      <div className="page">
                        <LoadingState label="Loading preview" />
                      </div>
                    }
                  >
                    <ComponentGallery />
                  </Suspense>
                }
              />
            )}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          {TokenSpecimen !== null && (
            <Route
              path="/dev/tokens"
              element={
                <Suspense
                  fallback={
                    <div className="page">
                      <LoadingState label="Loading preview" />
                    </div>
                  }
                >
                  <TokenSpecimen />
                </Suspense>
              }
            />
          )}
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
