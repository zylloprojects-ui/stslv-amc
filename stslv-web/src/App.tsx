import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { ProtectedRoute, RequirePermission } from './auth/guards'
import { AppLayout } from './layout/AppLayout'
import { ApiError } from './lib/api'
import type { Module } from './lib/types'
import { AccountPage } from './pages/AccountPage'
import { AmcContractsPage } from './pages/amc/AmcContractsPage'
import { AmcExecutionPage } from './pages/amc/AmcExecutionPage'
import { AmcSchedulePage } from './pages/amc/AmcSchedulePage'
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage'
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage'
import { SignUpPage } from './pages/auth/SignUpPage'
import { ClientsPage } from './pages/clients/ClientsPage'
import { DashboardPage } from './pages/DashboardPage'
import { ExpensesPage } from './pages/expenses/ExpensesPage'
import { AuthLayout, LoginPage } from './pages/LoginPage'
import { ModulePlaceholderPage } from './pages/ModulePlaceholderPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { ProcurementPage } from './pages/procurement/ProcurementPage'
import { ProjectDetailPage } from './pages/projects/ProjectDetailPage'
import { ProjectsPage } from './pages/projects/ProjectsPage'
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
  { path: '/invoices', module: 'INVOICES', title: 'Invoice Tracking' },
  { path: '/reports', module: 'REPORTS', title: 'Reports' },
]

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
            path="/amc/contracts"
            element={
              <RequirePermission module="AMC_CONTRACTS">
                <AmcContractsPage />
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
            path="/amc/execution"
            element={
              <RequirePermission module="AMC_EXECUTION">
                <AmcExecutionPage />
              </RequirePermission>
            }
          />
          <Route
            path="/projects"
            element={
              <RequirePermission module="PROJECTS">
                <ProjectsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <RequirePermission module="PROJECTS">
                <ProjectDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="/procurement"
            element={
              <RequirePermission module="PROCUREMENT">
                <ProcurementPage />
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
