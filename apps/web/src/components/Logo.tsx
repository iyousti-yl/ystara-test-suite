/**
 * Ystara's mark: a white "y" on sapphire with an amber dot, a stand-in in the
 * youlytics style until the brand's own files are in the project. The same
 * drawing is the favicon (public/favicon.svg).
 */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#1F3B70" />
      <path d="M9.5 9.5 16.4 19.5M22.5 9.5 13 25" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <circle cx="23.5" cy="23.5" r="2.6" fill="#D9962B" />
    </svg>
  );
}

/** "youlytics" as the brand writes it: "you" in 600, "lytics" in 400. */
export function Youlytics() {
  return (
    <span className="youlytics">
      <span className="youlytics-you">you</span>lytics
    </span>
  );
}
