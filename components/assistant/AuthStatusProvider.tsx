"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { SESSION_ENDED_EVENT, fetchAuthStatus } from "@/lib/api";
import type { AuthStatus } from "@/lib/types";

/** null until the first answer from /api/auth/me arrives. */
const AuthStatusContext = createContext<AuthStatus | null>(null);

/** Who is signed in and whether sign-in is required: asked of the server once, and again whenever an API call says 401. */
export function AuthStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void fetchAuthStatus().then((latest) => {
        if (mounted) setStatus(latest);
      });
    };
    refresh();
    window.addEventListener(SESSION_ENDED_EVENT, refresh);
    return () => {
      mounted = false;
      window.removeEventListener(SESSION_ENDED_EVENT, refresh);
    };
  }, []);

  return <AuthStatusContext.Provider value={status}>{children}</AuthStatusContext.Provider>;
}

export function useAuthStatus(): AuthStatus | null {
  return useContext(AuthStatusContext);
}
