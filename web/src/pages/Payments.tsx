import { useCallback, useEffect, useState } from "react";
import { api, fmtMoney, timeAgo } from "../api";

interface Payment {
  id: string;
  branchId: string | null;
  saleId: string | null;
  provider: string;
  phone: string;
  amount: string;
  status: "pending" | "confirmed" | "failed";
  providerReference: string | null;
  providerStatus: string | null;
  error: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

const STATUSES = ["all", "pending", "confirmed", "failed"] as const;

function StatusChip({ status }: { status: Payment["status"] }) {
  const cls = status === "confirmed" ? "ok" : status === "failed" ? "bad" : "neutral";
  return <span className={`chip ${cls}`}>{status}</span>;
}

export default function Payments() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = status === "all" ? "" : `?status=${status}`;
      const res = await api<{ payments: Payment[] }>(`/mobile-money/payments${qs}`);
      setPayments(res.payments);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load payments");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = {
    pending: payments.filter((p) => p.status === "pending").length,
    confirmed: payments.filter((p) => p.status === "confirmed").length,
    failed: payments.filter((p) => p.status === "failed").length,
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Mobile-money payments</h1>
          <div className="sub">
            Tender initiated from the till, reconciled asynchronously via the provider webhook — the sale is never held up waiting for a callback.
          </div>
        </div>
      </div>

      <div className="tabs">
        {STATUSES.map((s) => (
          <button key={s} className={`tab ${status === s ? "active" : ""}`} onClick={() => setStatus(s)}>
            {s === "all" ? "All" : s}
            {s !== "all" && <span className="tab-count">{counts[s]}</span>}
          </button>
        ))}
      </div>

      {error && <div className="err">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="loading">Loading payments…</div>
        ) : payments.length === 0 ? (
          <div className="empty">
            {status === "all" ? "No mobile-money payments yet — take one at the till with a phone number." : `No ${status} payments.`}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Phone</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>Provider ref</th>
                  <th>Sale</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="muted" title={new Date(p.createdAt).toLocaleString()}>
                      {timeAgo(p.createdAt)}
                    </td>
                    <td>{p.phone}</td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {fmtMoney(p.amount)}
                    </td>
                    <td>
                      <StatusChip status={p.status} />
                      {p.error && (
                        <div className="muted" style={{ fontSize: 12, maxWidth: 220 }}>
                          {p.error}
                        </div>
                      )}
                    </td>
                    <td className="muted">
                      {p.providerReference ?? "—"}
                      {p.providerStatus && <span style={{ color: "var(--text-2)" }}> · {p.providerStatus}</span>}
                    </td>
                    <td className="muted">{p.saleId ? p.saleId.slice(0, 8) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
