import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth.js';
import Layout from './components/Layout.js';
import LoginPage from './pages/LoginPage.js';

// Route-level code splitting: each module loads on demand so the first
// screen appears fast even on modest devices and connections.
const DashboardPage = lazy(() => import('./pages/DashboardPage.js'));
const ReceivingPage = lazy(() => import('./pages/ReceivingPage.js'));
const InventoryPage = lazy(() => import('./pages/InventoryPage.js'));
const ProductionPage = lazy(() => import('./pages/ProductionPage.js'));
const CustomersPage = lazy(() => import('./pages/CustomersPage.js'));
const SalesPage = lazy(() => import('./pages/SalesPage.js'));
const CreditPage = lazy(() => import('./pages/CreditPage.js'));
const PaymentsPage = lazy(() => import('./pages/PaymentsPage.js'));
const DeliveriesPage = lazy(() => import('./pages/DeliveriesPage.js'));
const SacksPage = lazy(() => import('./pages/SacksPage.js'));
const ReportsPage = lazy(() => import('./pages/ReportsPage.js'));
const UsersPage = lazy(() => import('./pages/UsersPage.js'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.js'));
const SetupPage = lazy(() => import('./pages/SetupPage.js'));
const AuditPage = lazy(() => import('./pages/AuditPage.js'));
const PrintPage = lazy(() => import('./pages/PrintPage.js'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
});

function Loading() {
  return <div className="centered-page">Loading…</div>;
}

function Shell() {
  const { loading, user } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <LoginPage />;
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        {/* printable documents render without the app chrome */}
        <Route path="/print/:kind/:id" element={<PrintPage />} />
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
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
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
