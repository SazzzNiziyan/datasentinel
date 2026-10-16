// Global styles first: tokens, then element defaults, then components.
import './styles/tokens.css';
import './styles/base.css';
import './styles/controls.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('index.html is missing the #root element');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
