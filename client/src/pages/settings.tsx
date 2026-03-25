import { useState } from 'react';
import { NICHES, TIMEFRAMES } from '@/lib/supabase';
import { User, Bell, Trash2 } from 'lucide-react';

export default function SettingsPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [defaultCategory, setDefaultCategory] = useState(NICHES[0].slug);
  const [defaultTimeframe, setDefaultTimeframe] = useState(TIMEFRAMES[0].label);
  const [notifyNewProducts, setNotifyNewProducts] = useState(true);
  const [notifyTrending, setNotifyTrending] = useState(false);
  const [notifyWeekly, setNotifyWeekly] = useState(true);

  return (
    <div className="p-6 max-w-3xl" data-testid="settings-page">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your profile and preferences
        </p>
      </div>

      {/* Profile */}
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <User size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Profile</h2>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Your name"
              className="w-full h-9 px-3 rounded-md text-sm border border-border bg-background text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="input-name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full h-9 px-3 rounded-md text-sm border border-border bg-background text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="input-email"
            />
          </div>
          <button
            className="h-8 px-4 rounded-md text-xs font-bold transition-colors"
            style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
            data-testid="btn-save-profile"
          >
            Save Changes
          </button>
        </div>
      </div>

      {/* Preferences */}
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <h2 className="text-sm font-semibold text-foreground mb-4">Default Preferences</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Default Category
            </label>
            <select
              value={defaultCategory}
              onChange={e => setDefaultCategory(e.target.value)}
              className="w-full h-9 px-3 rounded-md text-sm border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
              data-testid="select-default-category"
            >
              {NICHES.map(n => (
                <option key={n.slug} value={n.slug}>
                  {n.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Default Timeframe
            </label>
            <select
              value={defaultTimeframe}
              onChange={e => setDefaultTimeframe(e.target.value)}
              className="w-full h-9 px-3 rounded-md text-sm border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
              data-testid="select-default-timeframe"
            >
              {TIMEFRAMES.map(tf => (
                <option key={tf.label} value={tf.label}>
                  {tf.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Notifications */}
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <Bell size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
        </div>
        <div className="space-y-3">
          {[
            { label: 'New products in my categories', state: notifyNewProducts, setter: setNotifyNewProducts },
            { label: 'Trending video alerts', state: notifyTrending, setter: setNotifyTrending },
            { label: 'Weekly digest email', state: notifyWeekly, setter: setNotifyWeekly },
          ].map(item => (
            <div key={item.label} className="flex items-center justify-between">
              <span className="text-sm text-foreground">{item.label}</span>
              <button
                onClick={() => item.setter(!item.state)}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  item.state ? 'bg-[#a3ff00]' : 'bg-muted'
                }`}
                data-testid={`toggle-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 rounded-full transition-transform ${
                    item.state
                      ? 'translate-x-[18px] bg-[#0a0a0c]'
                      : 'translate-x-0.5 bg-foreground'
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Danger Zone */}
      <div className="rounded-lg border border-destructive/30 bg-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Trash2 size={16} className="text-destructive" />
          <h2 className="text-sm font-semibold text-destructive">Delete Account</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>
        <button
          className="h-8 px-4 rounded-md text-xs font-bold bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
          data-testid="btn-delete-account"
        >
          Delete Account
        </button>
      </div>
    </div>
  );
}
