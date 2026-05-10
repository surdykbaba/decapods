import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
 Briefcase, FolderKanban, Users, Banknote,
  Settings, LifeBuoy, Search, UserCheck,
  Sun, Moon, LogOut, ChevronDown,
  Handshake, UsersRound, Network, UserCog,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTheme, toggleTheme } from "@/lib/theme";
import { useHeartbeat } from "@/lib/presence";
import { NotificationsBell } from "@/components/NotificationsBell";
import { CommandPalette } from "@/components/CommandPalette";

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<any>;
  section: string;
};

const navTop: NavItem[] = [
  { section: "my_work",      to: "/my-work",      label: "My Accubin",   icon: UserCheck },
  { section: "pipeline",     to: "/pipeline",     label: "Pipeline",     icon: Briefcase },
  { section: "projects",     to: "/projects",     label: "Projects",     icon: FolderKanban },
  { section: "workforce",    to: "/workforce",    label: "Workforce",    icon: Users },
  { section: "members",      to: "/members",      label: "Members",      icon: UserCog },
  { section: "stakeholders", to: "/stakeholders", label: "Stakeholders", icon: UsersRound },
  { section: "vendors",      to: "/vendors",      label: "Vendors",      icon: Handshake },
  { section: "agents",       to: "/agents",       label: "PR & Agents",  icon: Network },
  { section: "finance",      to: "/finance",      label: "Finance",      icon: Banknote },
  { section: "settings",     to: "/settings",     label: "Settings",     icon: Settings },
];

export function Shell() {
  const { user, setUser, logout } = useAuth();
  const nav2 = useNavigate();
  const theme = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);

  // Mount the global heartbeat as soon as the user is authenticated. Pings
  // /me/heartbeat every minute while the tab is visible so directory pages
  // can show "online / away / offline" with relative time.
  useHeartbeat();

  // Sidebar role-visibility — server returns the section keys this user is
  // allowed to see. We default to the full nav while loading so the UI doesn't
  // flicker into an empty sidebar on slow connections.
  const { data: vis } = useQuery<{ sections: string[] }>({
    queryKey: ["me-visibility"],
    queryFn: () => api("/api/v1/me/visibility"),
    staleTime: 60_000,
  });
  const visibleNav = useMemo(() => {
    if (!vis?.sections) return navTop;
    const allow = new Set(vis.sections);
    return navTop.filter((n) => allow.has(n.section));
  }, [vis]);

  useEffect(() => {
    if (!user) api<any>("/api/v1/me").then(setUser).catch(() => {});
  }, [user, setUser]);

  // Global ⌘+K / ⌘+S to open palette
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (isCmdOrCtrl && (e.key === "k" || e.key === "K" || e.key === "s" || e.key === "S")) {
        // Don't hijack form fields' default behavior unless palette already open
        if (e.key.toLowerCase() === "s" && (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA")) {
          return;
        }
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === "Escape") setIdentityOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const initial = (user?.name ?? user?.email ?? "S")[0]?.toUpperCase();
  const displayName = user?.name?.trim() || user?.email?.split("@")[0] || "Signed in";
  const email = user?.email ?? "";

  return (
    <div className="h-full flex bg-bg">
      {/* Sidebar */}
      <aside className="w-[256px] shrink-0 flex flex-col px-3 py-4">
        <BrandLogo />

        <button
          onClick={() => setPaletteOpen(true)}
          className="mt-5 flex items-center gap-2.5 bg-surface border border-border rounded-xl px-3.5 py-3 text-[14px] text-muted hover:bg-bg/80 hover:border-accent/40 transition-colors"
        >
          <Search size={16} />
          <span className="flex-1 text-left">Search anything…</span>
          <kbd className="text-[11px] font-mono text-muted px-1.5 py-0.5 border border-border rounded bg-bg">⌘ K</kbd>
        </button>

        <nav className="mt-6 flex-1 overflow-y-auto space-y-1">
          {visibleNav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/dashboard"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3.5 py-3 rounded-xl text-[15px] font-semibold transition-colors ${
                  isActive
                    ? "bg-accent text-white shadow-soft"
                    : "text-muted hover:text-text hover:bg-surface"
                }`
              }
            >
              <n.icon size={18} />
              <span className="flex-1">{n.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Identity (sidebar footer) */}
        <div className="mt-3 pt-3 border-t border-border relative">
          <button
            onClick={() => setIdentityOpen((v) => !v)}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl transition-colors ${
              identityOpen ? "bg-surface" : "hover:bg-surface"
            }`}
          >
            <span className="w-9 h-9 rounded-full bg-accent-soft text-accent font-bold text-[14px] flex items-center justify-center shrink-0">
              {initial}
            </span>
            <span className="text-left leading-tight min-w-0 flex-1">
              <div className="text-[13px] font-bold text-text truncate">{displayName}</div>
              <div className="text-[11px] text-muted truncate">{email}</div>
            </span>
            <ChevronDown size={14} className="text-muted shrink-0" />
          </button>

          {identityOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setIdentityOpen(false)} />
              <div className="absolute left-1 right-1 bottom-full mb-2 z-40 bg-surface border border-border rounded-xl shadow-card py-2 overflow-hidden">
                <div className="px-4 py-3 border-b border-border">
                  <div className="flex items-center gap-3">
                    <span className="w-10 h-10 rounded-full bg-accent-soft text-accent font-bold text-base grid place-items-center shrink-0">
                      {initial}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-text truncate">{displayName}</div>
                      <div className="text-xs text-muted truncate">{email}</div>
                    </div>
                  </div>
                  {user?.roles && user.roles.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {user.roles.map((r) => (
                        <span key={r} className="pill bg-accent-soft text-accent">{r}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="py-1">
                  <DropdownItem
                    onClick={() => { setIdentityOpen(false); setPaletteOpen(true); }}
                    icon={<Search size={14} />}
                    label="Search"
                    kbd="⌘ K"
                  />
                  <DropdownItem
                    onClick={() => { setIdentityOpen(false); nav2("/settings"); }}
                    icon={<Settings size={14} />}
                    label="Workspace settings"
                  />
                  <DropdownItem
                    onClick={toggleTheme}
                    icon={theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
                    label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                  />
                  <DropdownItem
                    onClick={() => setIdentityOpen(false)}
                    icon={<LifeBuoy size={14} />}
                    label="Get support"
                  />
                </div>
                <div className="border-t border-border py-1">
                  <DropdownItem
                    onClick={() => { setIdentityOpen(false); logout(); nav2("/login"); }}
                    icon={<LogOut size={14} />}
                    label="Sign out"
                    danger
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Main panel */}
      <main className="flex-1 min-w-0 p-3 pl-0">
        <div className="h-full bg-surface rounded-3xl shadow-card border border-border flex flex-col overflow-hidden">
          {/* Top bar */}
          <header className="h-[68px] px-6 flex items-center gap-4 shrink-0">
            <div className="flex-1" />

            <button
              onClick={toggleTheme}
              className="p-2.5 hover:bg-bg rounded-full text-text"
              title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>

            <NotificationsBell />
          </header>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-auto px-8 pb-8">
            <Outlet />
          </div>
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function DropdownItem({
  icon, label, kbd, onClick, danger,
}: {
  icon: React.ReactNode;
  label: string;
  kbd?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2 text-[14px] hover:bg-bg ${
        danger ? "text-danger" : "text-text"
      }`}
    >
      <span className={`shrink-0 ${danger ? "text-danger" : "text-muted"}`}>{icon}</span>
      <span className="flex-1 text-left font-medium">{label}</span>
      {kbd && <kbd className="text-[11px] font-mono text-muted px-1.5 py-0.5 border border-border rounded bg-bg">{kbd}</kbd>}
    </button>
  );
}

function BrandLogo() {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1">
      <img
        src="/brand/logo-dark.png"
        alt="D'Accubin"
        className="w-9 h-9 rounded-lg object-cover"
      />
      <span className="text-[18px] font-extrabold tracking-tight text-text">D'Accubin</span>
    </div>
  );
}
