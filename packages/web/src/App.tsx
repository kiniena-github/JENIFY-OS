import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.js';
import Layout, { usePageTitle } from './components/Layout.js';
import LoginPage from './pages/LoginPage.js';

function Placeholder({ title }: { title: string }) {
  usePageTitle(title);
  return <div className="centered-page">This screen arrives in a later build phase.</div>;
}

function Shell() {
  const { loading, user } = useAuth();
  if (loading) return <div className="centered-page">Loading…</div>;
  if (!user) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Placeholder title="Dashboard" />} />
        <Route path="/receiving" element={<Placeholder title="Receiving" />} />
        <Route path="/inventory" element={<Placeholder title="Inventory" />} />
        <Route path="/production" element={<Placeholder title="Production" />} />
        <Route path="/customers" element={<Placeholder title="Customers" />} />
        <Route path="/sales" element={<Placeholder title="Sales" />} />
        <Route path="/credit" element={<Placeholder title="Credit" />} />
        <Route path="/payments" element={<Placeholder title="Payments" />} />
        <Route path="/deliveries" element={<Placeholder title="Deliveries" />} />
        <Route path="/sacks" element={<Placeholder title="Empty Sacks" />} />
        <Route path="/reports" element={<Placeholder title="Reports" />} />
        <Route path="/users" element={<Placeholder title="Users & Roles" />} />
        <Route path="/settings" element={<Placeholder title="Settings" />} />
        <Route path="/audit" element={<Placeholder title="Audit Log" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </BrowserRouter>
  );
}
