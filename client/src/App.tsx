import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BookmarkProvider } from "@/lib/bookmarks";
import { SubscriptionProvider } from "@/hooks/use-subscription";
import { AuthProvider, useAuth } from "@/lib/auth";
import { PaywallModal } from "@/components/PaywallModal";
import AppSidebar from "@/components/AppSidebar";
import VideosPage from "@/pages/videos";
import ProductsPage from "@/pages/products";
import SavedPage from "@/pages/saved";
import PlansPage from "@/pages/plans";
import BillingPage from "@/pages/billing";
import SettingsPage from "@/pages/settings";
import LandingPage from "@/pages/landing";
import LoginPage from "@/pages/login";
import SignupPage from "@/pages/signup";
import NotFound from "@/pages/not-found";

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Redirect to="/login" />;
  return <Component />;
}

function DashboardLayout() {
  return (
    <div className="flex min-h-screen" style={{ backgroundColor: '#0a0a0c' }}>
      <AppSidebar />
      <main className="flex-1 ml-[220px] min-h-screen">
        <Switch>
          <Route path="/dashboard" component={() => <ProtectedRoute component={VideosPage} />} />
          <Route path="/dashboard/products" component={() => <ProtectedRoute component={ProductsPage} />} />
          <Route path="/dashboard/saved" component={() => <ProtectedRoute component={SavedPage} />} />
          <Route path="/dashboard/plans" component={() => <ProtectedRoute component={PlansPage} />} />
          <Route path="/dashboard/billing" component={() => <ProtectedRoute component={BillingPage} />} />
          <Route path="/dashboard/settings" component={() => <ProtectedRoute component={SettingsPage} />} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}

function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Redirect to="/dashboard" />;
  return <LandingPage />;
}

function PublicRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Redirect to="/dashboard" />;
  return <Component />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={RootRedirect} />
      <Route path="/login" component={() => <PublicRoute component={LoginPage} />} />
      <Route path="/signup" component={() => <PublicRoute component={SignupPage} />} />
      <Route path="/dashboard/:rest*" component={DashboardLayout} />
      <Route path="/dashboard" component={DashboardLayout} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <BookmarkProvider>
            <SubscriptionProvider>
              <Toaster />
              <PaywallModal />
              <Router hook={useHashLocation}>
                <AppRouter />
              </Router>
            </SubscriptionProvider>
          </BookmarkProvider>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
