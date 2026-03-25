import { Link } from 'wouter';

export default function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-screen p-6">
      <div className="text-center">
        <p className="text-6xl font-mono font-bold text-[#a3ff00] mb-4">404</p>
        <h1 className="text-lg font-semibold text-foreground mb-2">Page not found</h1>
        <p className="text-sm text-muted-foreground mb-6">
          The page you're looking for doesn't exist.
        </p>
        <Link
          href="/"
          className="inline-flex items-center h-9 px-4 rounded-md text-sm font-bold no-underline"
          style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
        >
          Back to Videos
        </Link>
      </div>
    </div>
  );
}
