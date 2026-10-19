/** The owner page: requests, readers, exports and links (see docs/design.md, v0.3). */
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
