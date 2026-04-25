export function LoadingBar({ loading }: { loading: boolean }) {
  if (!loading) return null;

  return (
    <div className="flex items-center justify-center py-32">
      <div className="flex flex-col items-center gap-4">
        <div
          className="w-10 h-10 rounded-full border-[3px] border-zinc-700 animate-spin"
          style={{ borderTopColor: '#a3ff00' }}
        />
        <span className="text-xs text-zinc-500 font-mono">Loading...</span>
      </div>
    </div>
  );
}
