import React from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import Home from './routes/Home.tsx';
import Monitor from './routes/Monitor.tsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/run/:runId" element={<Monitor />} />
      </Routes>
    </BrowserRouter>
  );
}
