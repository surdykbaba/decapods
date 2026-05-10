// Shared avatar primitive. Renders the user's uploaded photo when present,
// falls back to a colored circle with their initials.
export function Avatar({
  name, email, src, size = 32, className = "",
}: {
  name?: string | null;
  email?: string | null;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const initials = (() => {
    const s = (name || email || "?").trim();
    const parts = s.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.charAt(0).toUpperCase();
  })();

  if (src) {
    return (
      <img
        src={src}
        alt={name || email || "Avatar"}
        className={`rounded-full object-cover shrink-0 ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={`rounded-full bg-accent-soft text-accent font-bold grid place-items-center shrink-0 ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.4) }}
    >
      {initials}
    </span>
  );
}
