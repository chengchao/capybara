export function CapyMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 24" className={className} fill="currentColor" aria-hidden="true">
      <ellipse cx="16.5" cy="14.5" rx="9.5" ry="6.4" />
      <circle cx="7.5" cy="12" r="5.4" />
      <circle cx="5.6" cy="7.2" r="1.7" />
      <rect x="12" y="19" width="2" height="3.6" rx="1" />
      <rect x="19" y="19" width="2" height="3.6" rx="1" />
    </svg>
  );
}
