import { Link, useLocation } from 'wouter';
import { Play, Package, Bookmark, CreditCard, Receipt, Settings } from 'lucide-react';

const NAV_ITEMS = [
  { path: '/', label: 'Videos', icon: Play },
  { path: '/products', label: 'Products', icon: Package },
  { path: '/saved', label: 'Saved', icon: Bookmark },
];

const BOTTOM_ITEMS = [
  { path: '/plans', label: 'Plans', icon: CreditCard },
  { path: '/billing', label: 'Billing', icon: Receipt },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export default function AppSidebar() {
  const [location] = useLocation();

  return (
    <aside
      className="fixed left-0 top-0 bottom-0 w-[220px] flex flex-col border-r border-border"
      style={{ backgroundColor: '#0d0d10' }}
      data-testid="sidebar"
    >
      {/* Logo */}
      <div className="h-14 flex items-center px-5 border-b border-border">
        <Link href="/" className="flex items-center gap-2.5 no-underline">
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center font-mono font-bold text-sm"
            style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
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
                    ? 'text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                }`}
                style={active ? { backgroundColor: '#a3ff00', color: '#0a0a0c' } : undefined}
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
                    ? 'text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                }`}
                style={active ? { backgroundColor: '#a3ff00', color: '#0a0a0c' } : undefined}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <item.icon size={16} strokeWidth={active ? 2.5 : 1.5} />
                {item.label}
              </Link>
            );
          })}
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
  );
}
