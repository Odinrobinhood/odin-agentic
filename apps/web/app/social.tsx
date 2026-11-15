/** Official social accounts. One place, so every link on the site stays the same. */
export const X_URL = 'https://x.com/Odin_Robinhood';

/** The X logo (simple path mark), sized by font-size via 1em. */
export function XLogo({ size = '1em' }: { size?: string | number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** Link to the X account: icon only (compact) or icon + handle. */
export function XLink({ label = false, className = '' }: { label?: boolean; className?: string }) {
  return (
    <a href={X_URL} target="_blank" rel="noopener noreferrer" className={`x-link ${className}`} aria-label="Odin Robinhood on X" title="@Odin_Robinhood on X">
      <XLogo />
      {label && <span>@Odin_Robinhood</span>}
    </a>
  );
}
