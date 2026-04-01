import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';

import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import '@mantine/notifications/styles.css';

import App from './App.tsx';
import { agentflowTheme } from './design/theme.ts';
import './styles/app.css';

const el = document.getElementById('root');
if (el) {
  const root = createRoot(el);
  root.render(
    <React.StrictMode>
      <MantineProvider theme={agentflowTheme} defaultColorScheme="light">
        <Notifications position="top-right" />
        <App />
      </MantineProvider>
    </React.StrictMode>,
  );
}
