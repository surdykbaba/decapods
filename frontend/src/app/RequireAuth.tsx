import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import type { ReactNode } from "react";

export function RequireAuth({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const { token, user } = useAuth();
  const loc = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: loc }} replace />;
  if (roles && user && !roles.some((r) => user.roles.includes(r))) {
    return <div className="p-8">Access denied.</div>;
  }
  return <>{children}</>;
}
