import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AppShell } from './app/AppShell.tsx';
import { primaryNav, secondaryNav } from './app/navigation.ts';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { PendingPage } from './pages/PendingPage.tsx';

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
      <Routes>
        <Route element={<AppShell />}>
          {[...primaryNav, ...secondaryNav].map((item) => (
            <Route key={item.path} path={item.path} element={<PendingPage item={item} />} />
          ))}
          {ComponentGallery !== null && (
            <Route
              path="/dev/components"
              element={
                <Suspense>
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
