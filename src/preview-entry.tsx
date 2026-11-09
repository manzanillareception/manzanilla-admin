import React from 'react';
import { createRoot } from 'react-dom/client';
import ControlCenter from './components/ControlCenter';
import './app/globals.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><ControlCenter /></React.StrictMode>);
