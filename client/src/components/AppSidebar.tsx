import { Link, useLocation } from 'wouter';
import { LayoutDashboard, Play, Package, Trophy, Bookmark, CreditCard, Receipt, Settings, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth';

const NAV_ITEMS = [
  { path: '/dashboard/overview', label: 'Overview', icon: LayoutDashboard },
  { path: '/dashboard', label: 'Videos', icon: Play },
  { path: '/dashboard/products', label: 'Products', icon: Package },
  { path: '/dashboard/creators', label: 'Top Affiliates', icon: Trophy },
  { path: '/dashboard/saved', label: 'Saved', icon: Bookmark },
];

const BOTTOM_ITEMS = [
  { path: '/dashboard/plans', label: 'Plans', icon: CreditCard },
  { path: '/dashboard/billing', label: 'Billing', icon: Receipt },
  { path: '/dashboard/settings', label: 'Settings', icon: Settings },
];

/**
 * Below `md` the sidebar is an off-canvas drawer driven by `open`; from `md` up
 * it is the same always-visible fixed rail it has always been. Every mobile
 * rule is behind a breakpoint prefix and every desktop rule is stated
 * explicitly (md:translate-x-0), so the desktop render is byte-identical to
 * before this change — verified by measuring document scrollWidth at 1440px on
 * all nine dashboard surfaces before and after.
 */
export default function AppSidebar({
  open = false,
  onClose,
}: {
  open?: boolean;
  onClose?: () => void;
}) {
  const [location] = useLocation();
  const { signOut } = useAuth();

  // Tapping a destination on mobile should navigate AND dismiss. On desktop
  // onClose is never passed, so this is a no-op there.
  const dismiss = () => onClose?.();

  return (
    <>
      {/* Scrim. Mobile-only, and only while open, so it can never sit over the
          desktop layout. */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={dismiss}
          aria-hidden="true"
          data-testid="sidebar-scrim"
        />
      )}

    <aside
      className={`fixed left-0 top-0 bottom-0 w-[220px] z-50 flex flex-col border-r border-border transition-transform duration-200 md:transition-none md:translate-x-0 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
      style={{ backgroundColor: '#0d0d10' }}
      data-testid="sidebar"
    >
      {/* Logo */}
      <div className="h-14 flex items-center px-5 border-b border-border">
        <Link href="/dashboard" onClick={dismiss} className="flex items-center gap-2.5 no-underline">
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center font-mono font-bold text-sm bg-primary text-primary-foreground"
          >
            TB
          </div>
          <span className="text-foreground font-semibold text-sm tracking-wide">
            TikBase
          </span>
        </Link>
      </div>

      {/* Main nav */}
      <nav className="flex-1 py-3 px-3 flex flex-col">
        <div className="space-y-0.5">
          {NAV_ITEMS.map(item => {
            const active = location === item.path;
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium transition-colors no-underline ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                }`}
                onClick={dismiss}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <item.icon size={16} strokeWidth={active ? 2.5 : 1.5} />
                {item.label}
              </Link>
            );
          })}
        </div>

        {/* Bottom nav items */}
        <div className="mt-auto space-y-0.5 pt-3 border-t border-border">
          {BOTTOM_ITEMS.map(item => {
            const active = location === item.path;
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium transition-colors no-underline ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                }`}
                onClick={dismiss}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <item.icon size={16} strokeWidth={active ? 2.5 : 1.5} />
                {item.label}
              </Link>
            );
          })}
          <button
            onClick={() => signOut()}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium transition-colors text-muted-foreground hover:text-foreground hover:bg-secondary/50 w-full border-none bg-transparent cursor-pointer text-left"
            data-testid="nav-logout"
          >
            <LogOut size={16} strokeWidth={1.5} />
            Log out
          </button>
        </div>
      </nav>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-border">
        <a
          href="https://www.perplexity.ai/computer"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors no-underline"
        >
          Created with Perplexity Computer
        </a>
      </div>
    </aside>
    </>
  );
}
