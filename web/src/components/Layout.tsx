import { NavLink, Outlet } from "react-router-dom";
import { signOut, useMe } from "../App";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/reports", label: "Reports" },
  { to: "/customers", label: "Customers" },
  { to: "/payments", label: "Payments" },
  { to: "/promotions", label: "Promotions" },
];

export default function Layout() {
  const me = useMe();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div className="brand-name">FlowWise</div>
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="org">{me?.orgName ?? "FlowWise"}</div>
          <div>{me?.userName ?? "Signed in"}</div>
          <button className="btn" style={{ background: "transparent", borderColor: "rgb(255 255 255 / 25%)", color: "#fff" }} onClick={signOut}>
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
