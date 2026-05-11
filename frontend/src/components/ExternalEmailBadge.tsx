import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { useAuth } from "@/lib/auth";

// External-email badge. Renders nothing when the address matches the
// workspace's primary domain (derived from the signed-in user's own email).
// Used on the Members directory, member profile hero, and invitation rows so
// HR can spot accounts that live outside the org at a glance.

function domainOf(email: string | undefined | null): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).toLowerCase();
}

export function useWorkspaceDomain(): string {
  const myEmail = useAuth((s) => s.user?.email);
  return useMemo(() => domainOf(myEmail), [myEmail]);
}

export function isExternalEmail(email: string | undefined | null, workspaceDomain: string): boolean {
  const d = domainOf(email);
  if (!d) return false;
  if (!workspaceDomain) return false;
  return d !== workspaceDomain;
}

export function ExternalEmailBadge({
  email, size = "sm", showDomain = false,
}: {
  email: string | undefined | null;
  size?: "xs" | "sm";
  showDomain?: boolean;
}) {
  const ws = useWorkspaceDomain();
  if (!isExternalEmail(email, ws)) return null;
  const d = domainOf(email);
  const cls =
    size === "xs"
      ? "text-[10px] px-1.5 py-0.5 gap-1"
      : "text-[11px] px-2 py-0.5 gap-1.5";
  return (
    <span
      className={`inline-flex items-center font-semibold rounded-full bg-warn/15 text-warn border border-warn/30 ${cls}`}
      title={`This account is on @${d}, not the workspace's @${ws} domain. Treat as an external collaborator.`}
    >
      <ExternalLink size={size === "xs" ? 9 : 11} />
      External{showDomain ? ` · @${d}` : ""}
    </span>
  );
}
