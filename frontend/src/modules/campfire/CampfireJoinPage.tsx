import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Lock, Hash, Users, ArrowRight, AlertCircle, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

// CampfireJoinPage — landing page for /campfire/join/:token.
//
// Two reasons this lives outside CampfirePage:
//   1. The token-preview fetch runs *before* the heavy CampfirePage
//      shell, so we can show a focused "join #channel-name?" card
//      instead of dropping the user into the full app and hoping they
//      notice a modal.
//   2. Acceptance is one click — no per-channel onboarding, no
//      mood-of-the-day, just "Join → redirect to /campfire". A user
//      who clicks the link from a DM shouldn't have to learn the
//      whole product before they can say hi.

type Preview = {
  room_id: string;
  name: string;
  description: string;
  is_private: boolean;
  member_count: number;
  status: "active" | "revoked" | "expired" | "exhausted";
  expires_at: string | null;
};

export function CampfireJoinPage() {
  const { token = "" } = useParams();
  const nav = useNavigate();

  const { data, isLoading, error } = useQuery<Preview>({
    queryKey: ["campfire", "invite-preview", token],
    queryFn: () => api(`/api/v1/campfire/invites/${token}`),
    enabled: !!token,
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () =>
      api<{ room_id: string }>(`/api/v1/campfire/invites/${token}/accept`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Joined channel");
      // Land them on the Campfire page; the room list refetch on mount
      // will surface the newly-joined room. No deep-link to the room
      // yet — the page picks default-or-first on its own.
      nav("/campfire");
    },
    onError: (e: any) => toast.error("Couldn't join", e?.message),
  });

  return (
    <div className="min-h-[60vh] grid place-items-center px-4">
      <div className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card p-6">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted">
            <Loader2 className="mx-auto mb-3 animate-spin" size={20} /> Reading invite…
          </div>
        ) : error || !data ? (
          <ErrorCard title="Invite link not found" body="This link might be from a different workspace, or it never existed." />
        ) : data.status !== "active" ? (
          <ErrorCard
            title={
              data.status === "revoked"  ? "This invite was revoked"
              : data.status === "expired" ? "This invite has expired"
              : "This invite hit its use limit"
            }
            body="Ask whoever shared the link to generate a fresh one."
          />
        ) : (
          <>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent-soft grid place-items-center shrink-0">
                {data.is_private ? <Lock size={18} className="text-warn" /> : <Hash size={18} className="text-accent" />}
              </div>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wider font-bold text-muted">
                  You've been invited to join
                </div>
                <h1 className="text-xl font-extrabold text-text mt-0.5 truncate">#{data.name}</h1>
                {data.description && (
                  <p className="text-[13px] text-muted mt-1">{data.description}</p>
                )}
                <div className="text-[11.5px] text-muted mt-2 inline-flex items-center gap-1.5">
                  <Users size={11} /> {data.member_count} member{data.member_count === 1 ? "" : "s"}
                  {data.expires_at && (
                    <span className="ml-1">· link expires {new Date(data.expires_at).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
            </div>

            <button
              onClick={() => accept.mutate()}
              disabled={accept.isPending}
              className="mt-5 w-full inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-xl bg-accent text-white hover:bg-[rgb(var(--accent-hover))] disabled:opacity-60"
            >
              {accept.isPending ? "Joining…" : <>Join channel <ArrowRight size={14} /></>}
            </button>
            <div className="text-center mt-3">
              <Link to="/campfire" className="text-[12px] text-muted hover:text-text">Skip — go to Campfire</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ErrorCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="text-center py-6">
      <AlertCircle size={28} className="mx-auto text-danger mb-3" />
      <div className="text-sm font-bold text-text">{title}</div>
      <div className="text-[12.5px] text-muted mt-1">{body}</div>
      <Link to="/campfire" className="inline-block mt-4 text-[12.5px] font-semibold text-accent hover:underline">
        Go to Campfire
      </Link>
    </div>
  );
}
