import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, fmtMoney, fmtPct } from "../api";

export default function Reports() {
  const [from, setFrom] = useState(() => {
    const d = new Date(Date.now() - 29 * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [daily, setDaily] = useState<Record<string, unknown>[]>([]);
  const [valuation, setValuation] = useState<Record<string, unknown>[]>([]);
  const [margin, setMargin] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({
      from: new Date(`${from}T00:00:00`).toISOString(),
      to: new Date(`${to}T23:59:59`).toISOString(),
    }).toString();
    Promise.all([
      api(`/reports/daily-sales?${qs}`),
      api("/reports/stock-valuation"),
      api(`/reports/margin?${qs}`),
    ])
      .then(([d, v, m]) => {
        if (!alive) return;
        setDaily((d as { daily: Record<string, unknown>[] }).daily);
        setValuation((v as { rows: Record<string, unknown>[] }).rows);
        setMargin((m as { rows: Record<string, unknown>[] }).rows);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not load reports"));
    return () => {
      alive = false;
    };
  }, [from, to]);

  const dailyData = daily.map((d) => ({ day: String(d.day).slice(5), total: Number(d.total), sales: Number(d.salesCount) }));
  const totalValuation = valuation.reduce((acc, r) => acc + Number(r.value), 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <div className="sub">Daily sales, stock valuation and margin — server-computed from the ledger.</div>
        </div>
        <div className="btn-row" style={{ alignItems: "center" }}>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
          <span className="muted">→</span>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
        </div>
      </div>

      {error && <div className="err">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Daily sales</h3>
        {dailyData.length === 0 ? (
          <div className="empty">No sales in this range.</div>
        ) : (
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--sand-200)" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="var(--ink-soft)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--ink-soft)" tickFormatter={(v) => `P${Number(v).toLocaleString()}`} />
                <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                <Bar dataKey="total" fill="#2a7d55" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Stock valuation by branch (on-hand × landed cost)</h3>
          <div className="stat" style={{ marginBottom: 10 }}>
            <div className="value">{fmtMoney(totalValuation)}</div>
            <div className="label">Total</div>
          </div>
          {valuation.length === 0 ? (
            <div className="empty">No stock on hand.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th className="num">Variants</th>
                    <th className="num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {valuation.map((r) => (
                    <tr key={String(r.branchId)}>
                      <td>{String(r.branchName)}</td>
                      <td className="num">{Number(r.variants).toLocaleString()}</td>
                      <td className="num">{fmtMoney(String(r.value))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Margin per variant (current-cost approximation)</h3>
          {margin.length === 0 ? (
            <div className="empty">No sales in this range.</div>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Units</th>
                    <th className="num">Revenue</th>
                    <th className="num">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {margin.slice(0, 25).map((r) => {
                    const marginValue = Number(r.margin);
                    const revenue = Number(r.revenue);
                    return (
                      <tr key={String(r.variantId)}>
                        <td>
                          {String(r.productName)} · {String(r.variantName)}
                        </td>
                        <td className="num">{Number(r.unitsSold).toLocaleString()}</td>
                        <td className="num">{fmtMoney(String(r.revenue))}</td>
                        <td className="num" style={{ color: marginValue < 0 ? "var(--danger)" : "var(--green-700)" }}>
                          {fmtMoney(String(r.margin))}{" "}
                          <span className="muted">({fmtPct(revenue > 0 ? marginValue / revenue : 0)})</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
