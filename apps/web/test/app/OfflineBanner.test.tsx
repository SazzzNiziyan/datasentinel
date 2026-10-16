import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineBanner } from '../../src/app/OfflineBanner.tsx';

function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OfflineBanner', () => {
  it('says nothing while the browser is online', () => {
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('announces when the connection drops and clears when it returns', () => {
    render(<OfflineBanner />);
    act(() => setOnline(false));
    expect(screen.getByRole('status')).toHaveTextContent("You're offline");
    act(() => setOnline(true));
    expect(screen.getByRole('status')).not.toHaveTextContent("You're offline");
  });

  it('announces when the connection comes back', () => {
    render(<OfflineBanner />);
    act(() => setOnline(false));
    act(() => setOnline(true));
    expect(screen.getByRole('status')).toHaveTextContent("You're back online.");
  });

  it('shows the banner when the page opens offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent("You're offline");
  });
});
