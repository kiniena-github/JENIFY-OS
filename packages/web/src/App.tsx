import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth.js';
import Layout from './components/Layout.js';
import LoginPage from './pages/LoginPage.js';
import ReceivingPage from './pages/ReceivingPage.js';
import InventoryPage from './pages/InventoryPage.js';
import ProductionPage from './pages/ProductionPage.js';
import CustomersPage from './pages/CustomersPage.js';
import SalesPage from './pages/SalesPage.js';
import CreditPage from './pages/CreditPage.js';
import DeliveriesPage from './pages/DeliveriesPage.js';
import PaymentsPage from './pages/PaymentsPage.js';
import DashboardPage from './pages/DashboardPage.js';
import ReportsPage from './pages/ReportsPage.js';
import SacksPage from './pages/SacksPage.js';
import UsersPage from './pages/UsersPage.js';
import SettingsPage from './pages/SettingsPage.js';
import AuditPage from './pages/AuditPage.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
});

function Shell() {
  const { loading, user } = useAuth();
  if (loading) return <div className="centered-page">Loading…</div>;
  if (!user) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/receiving" element={<ReceivingPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/production" element={<ProductionPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/credit" element={<CreditPage />} />
        <Route path="/payments" element={<PaymentsPage />} />
        <Route path="/deliveries" element={<DeliveriesPage />} />
        <Route path="/sacks" element={<SacksPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/audit" element={<AuditPage />} />
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
