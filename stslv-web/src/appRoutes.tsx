import type { QueryClient } from '@tanstack/react-query'
import { AppProviders, AppRoutes } from './App'

/**
 * The application as one splat route around the existing route tree, for a data router
 * (createBrowserRouter in the app, createMemoryRouter in the tests). A data router lets a page
 * with unsaved changes block any navigation, including Back/Forward (lib/unsavedChanges.tsx).
 */
export function appRouteObjects(client?: QueryClient) {
  return [
    {
      path: '*',
      element: (
        <AppProviders client={client}>
          <AppRoutes />
        </AppProviders>
      ),
    },
  ]
}
