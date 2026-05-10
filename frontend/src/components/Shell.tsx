import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, Briefcase, FolderKanban, Users, DollarSign,
  ShieldCheck, Github, Settings, LogOut, Bell, Search,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useEffect } from "react";
import { api } from "@/lib/api";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/pipeline", label: "Pipeline", icon: Briefcase },
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/workforce", label: "Workforce", icon: Users },
  { to: "/finance", label: "Finance", icon: DollarSign },
  { to: "/governance/policies", label: "Governance", icon: ShieldCheck },
  { to: "/integrations/github", label: "GitHub", icon: Github },
  { to: "/admin/users", label: "Admin", icon: Settings },
];

export function Shell() {
  const { user, setUser, logout } = useAuth();
  const nav2 = useNavigate();

  useEffect(() => {
    if (!user) api("/api/v1/me").then(setUser).catch(() => {});
  }, [user, setUser]);

  return (
    <div className="h-full grid" style={{ gridTemplateColumns: "240px 1fr" }}>
      <aside className="border-r border-border bg-surface flex flex-col">
        <div className="px-5 py-4 border-b border-border">
          <div className="text-sm font-bold tracking-wider">PGDP</div>
          <div className="text-xs text-muted">Governance & Delivery</div>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${
                  isActive ? "bg-border/60 text-text" : "text-muted hover:bg-border/30 hover:text-text"
                }`
              }
            >
              <n.icon size={16} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-border text-xs text-muted">
          v0.1.0 • {import.meta.env.MODE}
        </div>
      </aside>

      <main className="flex flex-col min-h-0">
        <header className="h-14 px-5 border-b border-border bg-surface flex items-center justify-between">
          <div className="flex items-center gap-2 text-muted">
            <Search size={16} />
            <input className="bg-transparent outline-none text-sm w-64" placeholder="Search ⌘K" />
          </div>
          <div className="flex items-center gap-3">
            <button className="btn-ghost"><Bell size={16} /></button>
            <div className="text-sm">
              <div>{user?.name ?? "—"}</div>
              <div className="text-xs text-muted">{user?.roles?.join(", ")}</div>
            </div>
            <button className="btn-ghost" onClick={() => { logout(); nav2("/login"); }}>
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
