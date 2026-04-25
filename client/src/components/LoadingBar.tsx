import { useEffect, useState } from 'react';

export function LoadingBar({ loading }: { loading: boolean }) {
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (loading) {
      setProgress(0);
      setVisible(true);
      // Animate progress: fast start, slow middle, never quite reaches 100
      const t1 = setTimeout(() => setProgress(30), 100);
      const t2 = setTimeout(() => setProgress(50), 400);
      const t3 = setTimeout(() => setProgress(70), 1000);
      const t4 = setTimeout(() => setProgress(85), 3000);
      const t5 = setTimeout(() => setProgress(92), 6000);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); clearTimeout(t5); };
    } else {
      setProgress(100);
      const hide = setTimeout(() => setVisible(false), 300);
      return () => clearTimeout(hide);
    }
  }, [loading]);

  if (!visible) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] h-[3px]">
      <div
        className="h-full transition-all duration-300 ease-out"
        style={{
          width: `${progress}%`,
          backgroundColor: '#a3ff00',
          boxShadow: '0 0 8px #a3ff00',
        }}
      />
    </div>
  );
}
