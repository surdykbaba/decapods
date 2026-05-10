import { create } from "zustand";
import { persist } from "zustand/middleware";
export const useAuth = create()(persist((set) => ({
    token: null,
    refresh: null,
    user: null,
    setTokens: (a, r) => set({ token: a, refresh: r }),
    setUser: (u) => set({ user: u }),
    logout: () => set({ token: null, refresh: null, user: null }),
}), { name: "pgdp-auth" }));
