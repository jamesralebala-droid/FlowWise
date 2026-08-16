import { useCallback, useEffect, useState } from "react";
import { api, fmtMoney } from "../api";

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  creditLimit: string;
  balance: string;
  loyaltyPoints: number;
  isActive: boolean;
}

export default function Customers() {
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [statement, setStatement] = useState<Record<string, unknown>[] | null>(null);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    try {
      const qs = query ? `?q=${encodeURIComponent(query)}` : "";
      const res = await api<{ customers: Customer[] }>(`/customers${qs}`);
      setCustomers(res.customers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load customers");
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const openStatement = async (c: Customer) => {
    setSelected(c);
    setStatement(null);
    setLoadingStatement(true);
    try {
      const res = await api<{ entries: Record<string, unknown>[] }>(`/customers/${c.id}/statement`);
      setStatement(res.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the statement");
    } finally {
      setLoadingStatement(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <div className="sub">Account balances, credit and loyalty points — derived from the append-only ledgers.</div>
        </div>
        <input className="input" style={{ width: 260 }} placeholder="Search name, phone or email…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void load(q)} />
      </div>

      {error && <div className="err">{error}</div>}

      <div className="card">
        {customers.length === 0 ? (
          <div className="empty">No customers{error ? "" : " — create one on the till first"}.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th className="num">Balance</th>
                  <th className="num">Credit limit</th>
                  <th className="num">Loyalty points</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td className="muted">{c.phone ?? c.email ?? "—"}</td>
                    <td className="num" style={{ color: Number(c.balance) > 0 ? "var(--danger)" : "var(--green-700)" }}>
                      {fmtMoney(c.balance)}
                    </td>
                    <td className="num muted">{fmtMoney(c.creditLimit)}</td>
                    <td className="num">{Number(c.loyaltyPoints).toLocaleString()}</td>
                    <td>{c.isActive ? <span className="chip ok">active</span> : <span className="chip neutral">inactive</span>}</td>
                    <td>
                      <button className="btn" style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => void openStatement(c)}>
                        Statement
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgb(31 42 36 / 45%)",
            display: "grid",
            placeItems: "center",
            padding: 24,
            zIndex: 20,
          }}
          onClick={() => setSelected(null)}
        >
          <div className="card" style={{ width: "100%", maxWidth: 640, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div className="page-head">
              <div>
                <h1 style={{ fontSize: 20 }}>{selected.name}</h1>
                <div className="sub">
                  Balance {fmtMoney(selected.balance)} · limit {fmtMoney(selected.creditLimit)} · {Number(selected.loyaltyPoints).toLocaleString()} pts
                </div>
              </div>
              <button className="btn" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            {loadingStatement ? (
              <div className="loading">Loading statement…</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Entry</th>
                      <th>Branch</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(statement ?? []).map((e) => (
                      <tr key={String(e.id)}>
                        <td className="muted">{new Date(String(e.businessTime)).toLocaleString()}</td>
                        <td>{String(e.entryType)}</td>
                        <td className="muted">{String(e.branchName ?? "—")}</td>
                        <td className="num" style={{ color: Number(e.amount) > 0 ? "var(--danger)" : "var(--green-700)" }}>
                          {fmtMoney(String(e.amount))}
                        </td>
                      </tr>
                    ))}
                    {(statement ?? []).length === 0 && (
                      <tr>
                        <td colSpan={4} className="empty">
                          No ledger entries.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
