import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth.js';
import Layout, { usePageTitle } from './components/Layout.js';
import LoginPage from './pages/LoginPage.js';
import ReceivingPage from './pages/ReceivingPage.js';
import InventoryPage from './pages/InventoryPage.js';
import ProductionPage from './pages/ProductionPage.js';
import CustomersPage from './pages/CustomersPage.js';
import SalesPage from './pages/SalesPage.js';
import CreditPage from './pages/CreditPage.js';
import DeliveriesPage from './pages/DeliveriesPage.js';
import PaymentsPage from './pages/PaymentsPage.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
});

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
        <Route path="/receiving" element={<ReceivingPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/production" element={<ProductionPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/credit" element={<CreditPage />} />
        <Route path="/payments" element={<PaymentsPage />} />
        <Route path="/deliveries" element={<DeliveriesPage />} />
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
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
