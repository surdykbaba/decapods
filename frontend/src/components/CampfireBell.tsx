import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame } from "lucide-react";
import { api } from "@/lib/api";

type UnreadResp = { count: number };

/**
 * Campfire top-bar entry point. Clicking it just navigates straight to the
 * full feed — no dropdown, no preview. The unread badge keeps the user
 * informed; visiting the page fires mark-seen, which the CampfirePage's
 * own mount effect handles.
 */
export function CampfireBell() {
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data } = useQuery<UnreadResp>({
    queryKey: ["campfire-unread"],
    queryFn: () => api("/api/v1/campfire/unread"),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const count = data?.count ?? 0;

  // Defensive mark-seen on click too — covers the user clicking the pill
  // very quickly after a refetch, before the CampfirePage's own effect runs.
  const markSeen = useMutation({
    mutationFn: () => api("/api/v1/campfire/mark-seen", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campfire-unread"] }),
  });

  function open() {
    if (count > 0 && !markSeen.isPending) markSeen.mutate();
    nav("/campfire");
  }

  return (
    <button
      onClick={open}
      className="group relative inline-flex items-center gap-2 pl-3 pr-3.5 py-1.5 rounded-full bg-gradient-to-br from-warn/15 via-accent-soft to-accent-soft hover:from-warn/20 hover:via-accent-soft hover:to-accent-soft border border-accent/30 text-text transition-all"
      aria-label={`Campfire${count ? ` (${count} unread)` : ""}`}
      title="Campfire"
    >
      <span className="relative grid place-items-center">
        <Flame size={16} className="text-warn animate-flicker" strokeWidth={2.5} />
      </span>
      <span className="text-[13px] font-bold tracking-tight text-accent">Campfire</span>
      {count > 0 && (
        <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold grid place-items-center ml-0.5">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </button>
  );
}
