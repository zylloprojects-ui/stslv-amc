import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { ProtectedRoute, RequireAdmin, RequireAnyPermission, RequirePermission } from './auth/guards'
import { AppLayout } from './layout/AppLayout'
import { NAVIGATION } from './layout/navigation'
import { ApiError } from './lib/api'
import type { Module } from './lib/types'
import { AccountPage } from './pages/AccountPage'
import { AmcContractsPage } from './pages/amc/AmcContractsPage'
import { AmcCalendarPage } from './pages/amc/AmcCalendarPage'
import { AmcSchedulePage } from './pages/amc/AmcSchedulePage'
import { ContractDetailPage } from './pages/amc/ContractDetailPage'
import { ServiceStatusPage } from './pages/amc/ServiceStatusPage'
import { ServicesSalesPage } from './pages/servicesSales/ServicesSalesPage'
import { AuditLogPage } from './pages/admin/AuditLogPage'
import { LoginHistoryPage } from './pages/admin/LoginHistoryPage'
import { DepartmentsPage } from './pages/masters/DepartmentsPage'
import { MasterDataCenterPage } from './pages/masters/MasterDataCenterPage'
import { MaintenanceFrequenciesPage } from './pages/masters/MaintenanceFrequenciesPage'
import { SalesEngineerDetailPage } from './pages/masters/SalesEngineerDetailPage'
import { SalesEngineersPage } from './pages/masters/SalesEngineersPage'
import { SystemTypesPage } from './pages/masters/SystemTypesPage'
import { ClientDetailPage } from './pages/clients/ClientDetailPage'
import { NotificationsPage } from './pages/notifications/NotificationsPage'
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage'
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage'
import { SignUpPage } from './pages/auth/SignUpPage'
import { ClientsPage } from './pages/clients/ClientsPage'
import { DashboardPage } from './pages/DashboardPage'
import { ExpensesPage } from './pages/expenses/ExpensesPage'
import { InvoicesPage } from './pages/invoices/InvoicesPage'
import { AuthLayout, LoginPage } from './pages/LoginPage'
import { LoaderPreviewPage } from './pages/LoaderPreviewPage'
import { ModulePlaceholderPage } from './pages/ModulePlaceholderPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { SettingsPage } from './pages/SettingsPage'
import { UsersPage } from './pages/users/UsersPage'

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // Retrying a request the API refused (4xx) cannot succeed.
        retry: (failureCount, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
      },
    },
  })
}

export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? createQueryClient())

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  )
}

// Modules that exist in the navigation but are not built yet. The navigation is the one place that says which.
const PENDING_MODULES: { path: string; module: Module; title: string }[] = NAVIGATION.flatMap((section) => section.items)
  .filter((item) => item.pending)
  .map((item) => ({ path: item.path, module: item.module, title: item.label }))

export function AppRoutes() {
  return (
    <Routes>
      {/* Open to visitors who are not signed in. They share one frame, so moving between them keeps it in place. */}
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          {/* A developer's page: it exists on a development server only, never in a production build. */}
          {import.meta.env.DEV && <Route path="/loader-preview" element={<LoaderPreviewPage />} />}
          <Route
            path="/dashboard"
            element={
              <RequirePermission module="DASHBOARD">
                <DashboardPage />
              </RequirePermission>
            }
          />
          <Route
            path="/clients"
            element={
              <RequirePermission module="CLIENTS">
                <ClientsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/clients/:id"
            element={
              <RequirePermission module="CLIENTS">
                <ClientDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="/master-data"
            element={
              <RequireAnyPermission modules={['CLIENTS', 'SETTINGS']}>
                <MasterDataCenterPage />
              </RequireAnyPermission>
            }
          />
          <Route
            path="/master-data/maintenance-frequencies"
            element={
              <RequirePermission module="SETTINGS">
                <MaintenanceFrequenciesPage />
              </RequirePermission>
            }
          />
          <Route
            path="/master-data/system-types"
            element={
              <RequirePermission module="SETTINGS">
                <SystemTypesPage />
              </RequirePermission>
            }
          />
          <Route
            path="/master-data/departments"
            element={
              <RequirePermission module="SETTINGS">
                <DepartmentsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/master-data/sales-engineers"
            element={
              <RequirePermission module="SETTINGS">
                <SalesEngineersPage />
              </RequirePermission>
            }
          />
          <Route
            path="/master-data/sales-engineers/:id"
            element={
              <RequirePermission module="SETTINGS">
                <SalesEngineerDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="/amc/contracts"
            element={
              <RequirePermission module="AMC_CONTRACTS">
                <AmcContractsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/amc/contracts/:id"
            element={
              <RequirePermission module="AMC_CONTRACTS">
                <ContractDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="/amc/schedule"
            element={
              <RequirePermission module="AMC_SCHEDULE">
                <AmcSchedulePage />
              </RequirePermission>
            }
          />
          <Route
            path="/amc/calendar"
            element={
              <RequirePermission module="AMC_SCHEDULE">
                <AmcCalendarPage />
              </RequirePermission>
            }
          />
          <Route
            path="/amc/service-status"
            element={
              <RequirePermission module="AMC_SCHEDULE">
                <ServiceStatusPage />
              </RequirePermission>
            }
          />
          <Route
            path="/amc/services-sales"
            element={
              <RequirePermission module="SERVICES_SALES">
                <ServicesSalesPage />
              </RequirePermission>
            }
          />
          <Route
            path="/expenses"
            element={
              <RequirePermission module="EXPENSES">
                <ExpensesPage />
              </RequirePermission>
            }
          />
          <Route
            path="/invoices"
            element={
              <RequirePermission module="INVOICES">
                <InvoicesPage />
              </RequirePermission>
            }
          />
          {PENDING_MODULES.map((pending) => (
            <Route
              key={pending.path}
              path={pending.path}
              element={
                <RequirePermission module={pending.module}>
                  <ModulePlaceholderPage title={pending.title} />
                </RequirePermission>
              }
            />
          ))}
          <Route
            path="/admin/users"
            element={
              <RequirePermission module="USERS">
                <UsersPage />
              </RequirePermission>
            }
          />
          <Route
            path="/admin/roles"
            element={
              <RequirePermission module="USERS">
                <UsersPage key="roles" initialTab="roles" />
              </RequirePermission>
            }
          />
          <Route
            path="/admin/login-history"
            element={
              <RequirePermission module="USERS">
                <LoginHistoryPage />
              </RequirePermission>
            }
          />
          <Route
            path="/admin/audit-log"
            element={
              <RequireAdmin>
                <AuditLogPage />
              </RequireAdmin>
            }
          />
          <Route path="/notifications" element={<NotificationsPage />} />
          {/* The former combined System Types & Departments page. */}
          <Route path="/admin/master-data" element={<Navigate to="/master-data" replace />} />
          <Route
            path="/settings"
            element={
              <RequirePermission module="SETTINGS">
                <SettingsPage />
              </RequirePermission>
            }
          />
          <Route path="/account" element={<AccountPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProviders>
        <AppRoutes />
      </AppProviders>
    </BrowserRouter>
  )
}
