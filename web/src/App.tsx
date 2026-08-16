import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, clearSession, loadSession, type Session } from "./api";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Reports from "./pages/Reports";
import Customers from "./pages/Customers";
import Payments from "./pages/Payments";
import Promotions from "./pages/Promotions";
import Pos from "./pages/Pos";
import SupplierLogin from "./pages/supplier/SupplierLogin";
import SupplierLayout, { RequireSupplier } from "./pages/supplier/SupplierLayout";
import SupplierPos from "./pages/supplier/SupplierPos";
import SupplierPrices from "./pages/supplier/SupplierPrices";
import SupplierProfile from "./pages/supplier/SupplierProfile";

function RequireSession({ children }: { children: React.ReactNode }) {
  const [session] = useState<Session | null>(() => loadSession());
  const location = useLocation();
  if (!session) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireSession>
            <Layout />
          </RequireSession>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="reports" element={<Reports />} />
        <Route path="customers" element={<Customers />} />
        <Route path="payments" element={<Payments />} />
        <Route path="promotions" element={<Promotions />} />
        <Route path="pos" element={<Pos />} />
      </Route>
      <Route path="/supplier/login" element={<SupplierLogin />} />
      <Route
        path="/supplier"
        element={
          <RequireSupplier>
            <SupplierLayout />
          </RequireSupplier>
        }
      >
        <Route index element={<SupplierPos />} />
        <Route path="prices" element={<SupplierPrices />} />
        <Route path="profile" element={<SupplierProfile />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Signed-out bounce helper used by the login page after a successful sign-in. */
export function useMe(): { orgName: string; userName: string } | null {
  const [me, setMe] = useState<{ orgName: string; userName: string } | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ org?: { name?: string }; name?: string }>("/me")
      .then((m) => {
        if (alive) setMe({ orgName: m.org?.name ?? "FlowWise", userName: m.name ?? "" });
      })
      .catch(() => {
        if (alive) setMe(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  return me;
}

export function signOut(): void {
  clearSession();
  window.location.href = "/login";
}
