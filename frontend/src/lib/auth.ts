import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Me = {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  roles: string[];
};

type State = {
  token: string | null;
  refresh: string | null;
  user: Me | null;
  setTokens: (a: string, r: string) => void;
  setUser: (u: Me) => void;
  logout: () => void;
};

export const useAuth = create<State>()(
  persist(
    (set) => ({
      token: null,
      refresh: null,
      user: null,
      setTokens: (a, r) => set({ token: a, refresh: r }),
      setUser: (u) => set({ user: u }),
      logout: () => set({ token: null, refresh: null, user: null }),
    }),
    { name: "pgdp-auth" },
  ),
);
