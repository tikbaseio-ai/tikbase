import { useState, useEffect, useSyncExternalStore } from "react";
import { Switch, Route, Router, Redirect, Link, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BookmarkProvider } from "@/lib/bookmarks";
import { SubscriptionProvider } from "@/hooks/use-subscription";
import { AuthProvider, useAuth } from "@/lib/auth";
import { PaywallModal } from "@/components/PaywallModal";
import { Menu } from "lucide-react";
import AppSidebar from "@/components/AppSidebar";
import GlobalSearch from "@/components/GlobalSearch";
import OverviewPage from "@/pages/overview";
import VideosPage from "@/pages/videos";
import CreatorsPage from "@/pages/creators";
import CreatorProfilePage from "@/pages/creator-profile";
import BrandProfilePage from "@/pages/brand-profile";
import ProductDetailPage from "@/pages/product-detail";
import ProductsPage from "@/pages/products";
import SavedPage from "@/pages/saved";
import PlansPage from "@/pages/plans";
import BillingPage from "@/pages/billing";
import SettingsPage from "@/pages/settings";
import LandingPage from "@/pages/landing";
import LoginPage from "@/pages/login";
import SignupPage from "@/pages/signup";
import SubscriptionSuccessPage from "@/pages/subscription-success";
import NotFound from "@/pages/not-found";
import { MaintenanceScreen } from "@/components/MaintenanceScreen";
import { getServiceState, subscribeServiceState, startServiceWatch } from "@/lib/service-health";

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Redirect to="/login" />;
  return <Component />;
}

function DashboardLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const [location] = useLocation();

  // Any navigation closes the drawer. Route changes that do not originate from
  // a nav tap (back button, a link inside a page) would otherwise leave it open
  // over the new page.
  useEffect(() => { setNavOpen(false); }, [location]);

  // Escape closes it too — the drawer traps the whole screen behind a scrim, so
  // it needs a keyboard way out for anyone on a small laptop or with a keyboard
  // attached to a tablet.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className="flex min-h-screen" style={{ backgroundColor: '#0a0a0c' }}>
      <AppSidebar open={navOpen} onClose={() => setNavOpen(false)} />
      {/* min-w-0 lets the overflow-x-auto table wrappers actually scroll: a flex
          item defaults to min-width:auto, which lets a wide table push the whole
          document wider instead. Gated at md so the desktop layout — which has
          no overflow today — is untouched. */}
      <main className="flex-1 min-w-0 md:min-w-[auto] md:ml-[220px] min-h-screen">
        {/* Top bar. It exists at every breakpoint now because it carries the
            global search; the hamburger and wordmark remain mobile-only, since
            desktop already has the sidebar for both. */}
        <header
          className="sticky top-0 z-30 h-14 flex items-center gap-3 px-4 border-b border-border"
          style={{ backgroundColor: '#0d0d10' }}
        >
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            className="md:hidden h-9 w-9 -ml-1.5 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 border-none bg-transparent cursor-pointer flex-shrink-0"
            data-testid="nav-open"
          >
            <Menu size={20} />
          </button>
          <Link href="/dashboard" className="md:hidden flex items-center gap-2 no-underline flex-shrink-0">
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center font-mono font-bold text-xs"
              style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
            >
              TB
            </div>
          </Link>
          <GlobalSearch />
        </header>

        <Switch>
          <Route path="/dashboard" component={() => <ProtectedRoute component={VideosPage} />} />
          <Route path="/dashboard/overview" component={() => <ProtectedRoute component={OverviewPage} />} />
          <Route path="/dashboard/products" component={() => <ProtectedRoute component={ProductsPage} />} />
          <Route path="/dashboard/creators" component={() => <ProtectedRoute component={CreatorsPage} />} />
          {/* Before nothing else — :key is URL-encoded ('id%3A<digits>' for the
              numeric half of the creator universe). */}
          <Route path="/dashboard/creator/:key" component={() => <ProtectedRoute component={CreatorProfilePage} />} />
          <Route path="/dashboard/product/:id" component={() => <ProtectedRoute component={ProductDetailPage} />} />
          {/* :sellerId is URL-encoded — it is either a numeric seller id or
              'name:<shop>', and shop names contain spaces and slashes. */}
          <Route path="/dashboard/brand/:sellerId" component={() => <ProtectedRoute component={BrandProfilePage} />} />
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
      <Route path="/subscription-success" component={SubscriptionSuccessPage} />
      {/* '/dashboard/*', not '/dashboard/:rest*': the named-param form matches a
          SINGLE trailing segment, which was invisible while every dashboard page
          was exactly two segments deep. /dashboard/creator/:key is the first
          three-segment route and fell through to the 404 without this. */}
      <Route path="/dashboard/*" component={DashboardLayout} />
      <Route path="/dashboard" component={DashboardLayout} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  // Outside every provider on purpose. AuthProvider, SubscriptionProvider and
  // BookmarkProvider all reach for the network as they mount, and while the
  // project is restricted those calls either fail or — worse — succeed with an
  // empty body that reads as real data. Nothing below this line mounts until
  // the backend is known to be there.
  const service = useSyncExternalStore(subscribeServiceState, getServiceState, getServiceState);
  useEffect(() => { startServiceWatch(); }, []);
  if (service === 'restricted') return <MaintenanceScreen />;

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
