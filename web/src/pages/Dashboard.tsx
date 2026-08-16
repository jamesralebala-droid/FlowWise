import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, fmtMoney, timeAgo } from "../api";

const PERIODS = [
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
];

const TENDER_COLORS: Record<string, string> = {
  cash: "#2a7d55",
  card: "#1a4a38",
  mobile_money: "#d9a441",
  credit: "#8a6d2f",
  other: "#a8a29a",
};

function periodRange(days: number): { from?: string; to?: string } {
  if (days === 0) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { from: start.toISOString(), to: new Date().toISOString() };
  }
  const from = new Date(Date.now() - days * 86400000);
  return { from: from.toISOString(), to: new Date().toISOString() };
}

export default function Dashboard() {
  const [period, setPeriod] = useState(PERIODS[1]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [top, setTop] = useState<Record<string, unknown>[]>([]);
  const [payments, setPayments] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams(periodRange(period.days)).toString();
    Promise.all([
      api(`/reports/sales-summary?${qs}`),
      api(`/reports/top-products?limit=6`),
      api("/mobile-money/payments?limit=20"),
    ])
      .then(([s, t, p]) => {
        if (!alive) return;
        setSummary(s as Record<string, unknown>);
        setTop((t as { rows: Record<string, unknown>[] }).rows);
        setPayments((p as { payments: Record<string, unknown>[] }).payments);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not load the dashboard"));
    return () => {
      alive = false;
    };
  }, [period]);

  const totals = (summary?.totals as Record<string, unknown> | undefined) ?? {};
  const tenders = (summary?.tenders as { tenderType: string; amount: string; count: number }[] | undefined) ?? [];
  const mobileMoney = (summary?.mobileMoney as Record<string, unknown> | undefined) ?? {};
  const loyalty = (summary?.loyalty as Record<string, unknown> | undefined) ?? {};

  const tenderPie = useMemo(
    () =>
      tenders.map((t) => ({
        name: t.tenderType.replace("_", " "),
        value: Number(t.amount),
        color: TENDER_COLORS[t.tenderType] ?? "#a8a29a",
      })),
    [tenders],
  );

  const topRows = top.map((r) => ({
    name: `${r.productName} · ${r.variantName}`,
    revenue: Number(r.revenue),
  }));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">Sales, tenders and payments across your branches.</div>
        </div>
        <div className="btn-row">
          {PERIODS.map((p) => (
            <button key={p.key} className={`btn ${p.key === period.key ? "active" : ""}`} onClick={() => setPeriod(p)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="err">{error}</div>}
      {!summary && !error && <div className="loading">Loading…</div>}

      {summary && (
        <>
          <div className="grid stats">
            <div className="card stat">
              <div className="value">{fmtMoney(totals.netTotal)}</div>
              <div className="label">Net sales</div>
              <div className="delta">{fmtMoney(totals.refundTotal)} refunded</div>
            </div>
            <div className="card stat">
              <div className="value">{Number(totals.salesCount ?? 0).toLocaleString()}</div>
              <div className="label">Transactions</div>
              <div className="delta">avg {fmtMoney(totals.averageSale)}</div>
            </div>
            <div className="card stat">
              <div className="value">{fmtMoney(totals.discountTotal)}</div>
              <div className="label">Discounts given</div>
              <div className="delta">+ {fmtMoney(totals.loyaltyCredit)} loyalty credit</div>
            </div>
            <div className="card stat">
              <div className="value">{fmtMoney(mobileMoney.confirmedTotal)}</div>
              <div className="label">Mobile money</div>
              <div className="delta">
                {Number(mobileMoney.confirmedCount ?? 0)} confirmed · {Number(mobileMoney.pendingCount ?? 0)} pending
              </div>
            </div>
          </div>

          <div style={{ height: 18 }} />

          <div className="grid two">
            <div className="card">
              <h3>Tender mix</h3>
              {tenderPie.length === 0 ? (
                <div className="empty">No sales in this period.</div>
              ) : (
                <div style={{ height: 240 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={tenderPie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={3}>
                        {tenderPie.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", marginTop: 6 }}>
                {tenderPie.map((t) => (
                  <span key={t.name} style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                    <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: t.color, marginRight: 6 }} />
                    {t.name} · {fmtMoney(t.value)}
                  </span>
                ))}
              </div>
            </div>

            <div className="card">
              <h3>Top products</h3>
              {topRows.length === 0 ? (
                <div className="empty">No sales yet.</div>
              ) : (
                <div style={{ height: 240 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={topRows} layout="vertical" margin={{ left: 8, right: 8 }}>
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="name" width={190} tick={{ fontSize: 12 }} />
                      <Bar dataKey="revenue" fill="#2a7d55" radius={[0, 6, 6, 0]} />
                      <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          <div style={{ height: 18 }} />

          <div className="grid two">
            <div className="card">
              <h3>Loyalty</h3>
              <div className="grid stats" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div className="stat">
                  <div className="value">{Number(loyalty.pointsEarned ?? 0).toLocaleString()}</div>
                  <div className="label">Points earned</div>
                </div>
                <div className="stat">
                  <div className="value">{Number(loyalty.pointsRedeemed ?? 0).toLocaleString()}</div>
                  <div className="label">Points redeemed</div>
                </div>
              </div>
            </div>

            <div className="card">
              <h3>Latest mobile-money payments</h3>
              {payments.length === 0 ? (
                <div className="empty">No mobile-money payments yet.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Phone</th>
                        <th className="num">Amount</th>
                        <th>Status</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.slice(0, 6).map((p) => (
                        <tr key={String(p.id)}>
                          <td>{String(p.phone)}</td>
                          <td className="num">{fmtMoney(String(p.amount))}</td>
                          <td>
                            <StatusChip status={String(p.status)} />
                          </td>
                          <td className="muted">{timeAgo(String(p.createdAt))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  const cls = status === "confirmed" ? "ok" : status === "pending" ? "pending" : status === "failed" ? "bad" : "neutral";
  return <span className={`chip ${cls}`}>{status}</span>;
}
