import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Providers } from './context';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <Providers>
    <App />
  </Providers>,
);
