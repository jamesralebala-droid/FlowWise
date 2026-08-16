import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { clearSupplierSession, loadSupplierSession, supplierApi } from "../../api";

export function RequireSupplier({ children }: { children: React.ReactNode }) {
  const [session] = useState(() => loadSupplierSession());
  const location = useLocation();
  if (!session) return <Navigate to="/supplier/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

const NAV = [
  { to: "/supplier", label: "Purchase orders", end: true },
  { to: "/supplier/prices", label: "My price list" },
  { to: "/supplier/profile", label: "Profile" },
];

export default function SupplierLayout() {
  const [me, setMe] = useState<{ supplierName?: string; name?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    supplierApi<Record<string, unknown>>("/me")
      .then((m) => alive && setMe({ supplierName: String(m.supplierName ?? ""), name: String(m.name ?? "") }))
      .catch(() => alive && setMe({}));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div className="brand-name">Supplier portal</div>
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="org">{me?.supplierName ?? "FlowWise supplier"}</div>
          <div>{me?.name ?? ""}</div>
          <button
            className="btn"
            style={{ background: "transparent", borderColor: "rgb(255 255 255 / 25%)", color: "#fff" }}
            onClick={() => {
              clearSupplierSession();
              window.location.href = "/supplier/login";
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
