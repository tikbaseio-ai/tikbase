import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BookmarkProvider } from "@/lib/bookmarks";
import { SubscriptionProvider } from "@/hooks/use-subscription";
import { PaywallModal } from "@/components/PaywallModal";
import AppSidebar from "@/components/AppSidebar";
import VideosPage from "@/pages/videos";
import ProductsPage from "@/pages/products";
import SavedPage from "@/pages/saved";
import PlansPage from "@/pages/plans";
import BillingPage from "@/pages/billing";
import SettingsPage from "@/pages/settings";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <div className="flex min-h-screen" style={{ backgroundColor: '#0a0a0c' }}>
      <AppSidebar />
      <main className="flex-1 ml-[220px] min-h-screen">
        <Switch>
          <Route path="/" component={VideosPage} />
          <Route path="/products" component={ProductsPage} />
          <Route path="/saved" component={SavedPage} />
          <Route path="/plans" component={PlansPage} />
          <Route path="/billing" component={BillingPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BookmarkProvider>
          <SubscriptionProvider>
            <Toaster />
            <PaywallModal />
            <Router hook={useHashLocation}>
              <AppRouter />
            </Router>
          </SubscriptionProvider>
        </BookmarkProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
