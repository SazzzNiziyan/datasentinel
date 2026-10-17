import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// Unit tests never use the network: a component that calls the API without
// a test stub gets a network error, as if the API were down. Tests that
// need answers stub fetch themselves.
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network is disabled in tests')));
});

afterEach(() => {
  cleanup();
});
