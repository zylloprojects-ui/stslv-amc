import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { ProtectedRoute, RequirePermission } from './auth/guards'
import { AppLayout } from './layout/AppLayout'
import { ApiError } from './lib/api'
import type { Module } from './lib/types'
import { AccountPage } from './pages/AccountPage'
import { ClientsPage } from './pages/clients/ClientsPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
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

// Modules that exist in the navigation but are not built yet.
const PENDING_MODULES: { path: string; module: Module; title: string }[] = [
  { path: '/amc/contracts', module: 'AMC_CONTRACTS', title: 'AMC Contracts' },
  { path: '/amc/schedule', module: 'AMC_SCHEDULE', title: 'AMC Schedule' },
  { path: '/amc/execution', module: 'AMC_EXECUTION', title: 'AMC Execution' },
  { path: '/projects', module: 'PROJECTS', title: 'Projects' },
  { path: '/procurement', module: 'PROCUREMENT', title: 'Procurement' },
  { path: '/expenses', module: 'EXPENSES', title: 'Expenses' },
  { path: '/invoices', module: 'INVOICES', title: 'Invoice Tracking' },
  { path: '/reports', module: 'REPORTS', title: 'Reports' },
]

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
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
