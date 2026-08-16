import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  closeShift,
  completeSale,
  fmtMoney,
  getSale,
  listCurrencies,
  openShift,
  posCatalogue,
  recentSales,
  refundSale,
  type PosCurrency,
  type PosProduct,
} from "../api";

interface CartLine {
  variantId: string;
  name: string;
  price: string;
  qty: number;
}

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  loyaltyPoints: number;
}

interface TenderRow {
  type: string;
  amount: string;
  currency: string;
  reference: string;
}

const TENDER_TYPES = [
  { key: "cash", label: "Cash" },
  { key: "card", label: "Card" },
  { key: "mobile_money", label: "Mobile money" },
  { key: "credit", label: "Credit" },
  { key: "other", label: "Other" },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function Pos() {
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [baseCurrency, setBaseCurrency] = useState("BWP");
  const [currencies, setCurrencies] = useState<PosCurrency[]>([]);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [branchId, setBranchId] = useState<string>("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [q, setQ] = useState("");
  const [tenders, setTenders] = useState<TenderRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string>("");
  const [promoCode, setPromoCode] = useState("");
  const [loyaltyPoints, setLoyaltyPoints] = useState("");
  const [shift, setShift] = useState<{ id: string } | null>(null);
  const [shiftMsg, setShiftMsg] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);
  const [sales, setSales] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchCust, setSearchCust] = useState("");

  const loadAll = useCallback(async () => {
    try {
      const [cat, cur, me] = await Promise.all([posCatalogue(), listCurrencies(), api<{ branches: { id: string; name: string }[]; defaultBranch: { id: string } | null }>("/me")]);
      setProducts(cat.products);
      setBaseCurrency(cat.currency);
      setCurrencies(cur);
      setBranches(me.branches);
      const preferred = me.defaultBranch?.id ?? me.branches[0]?.id ?? "";
      setBranchId((prev) => prev || preferred);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the till");
    }
  }, []);

  const loadCustomers = useCallback(async () => {
    try {
      const res = await api<{ customers: Customer[] }>("/customers?limit=100");
      setCustomers(res.customers);
    } catch {
      /* picker stays empty — cash/card still works */
    }
  }, []);

  const loadSales = useCallback(async () => {
    try {
      setSales(await recentSales());
    } catch {
      /* offline-safe */
    }
  }, []);

  useEffect(() => {
    void loadAll();
    void loadCustomers();
    void loadSales();
  }, [loadAll, loadCustomers, loadSales]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return products;
    return products.filter((p) => `${p.productName} ${p.variantName} ${p.sku ?? ""}`.toLowerCase().includes(needle));
  }, [products, q]);

  const total = useMemo(() => round2(cart.reduce((acc, l) => acc + Number(l.price) * l.qty, 0)), [cart]);

  const addProduct = (p: PosProduct) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.variantId === p.variantId);
      if (existing) return prev.map((l) => (l.variantId === p.variantId ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { variantId: p.variantId, name: `${p.productName} · ${p.variantName}`, price: p.price, qty: 1 }];
    });
  };

  const changeQty = (variantId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => (l.variantId === variantId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    );
  };

  const setTenderAmount = (type: string, amount: string, currency: string) => {
    setTenders((prev) => {
      const rest = prev.filter((t) => !(t.type === type && t.currency === currency));
      if (!amount || Number(amount) <= 0) return rest;
      return [...rest, { type, amount, currency, reference: type === "mobile_money" ? (prev.find((t) => t.type === "mobile_money")?.reference ?? "") : "" }];
    });
  };

  const tenderTotal = useMemo(() => {
    const byBase = tenders.map((t) => {
      const c = currencies.find((cc) => cc.code === t.currency);
      return t.currency === baseCurrency || !c ? Number(t.amount) : Number(t.amount) * Number(c.rateToBase);
    });
    return round2(byBase.reduce((a, b) => a + b, 0));
  }, [tenders, currencies, baseCurrency]);

  const change = round2(tenderTotal - total);
  const foreignTenders = tenders.filter((t) => t.currency !== baseCurrency);

  const selectedCustomer = customers.find((c) => c.id === customerId);

  const doOpenShift = async (opening: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await openShift(branchId, opening || "0");
      setShift({ id: String(res.id) });
      setShiftMsg(`Shift opened with P ${Number(opening || 0).toFixed(2)} float`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open shift");
    } finally {
      setBusy(false);
    }
  };

  const doCloseShift = async (declaredCash: string) => {
    if (!shift) return;
    setBusy(true);
    setError(null);
    try {
      const res = await closeShift(shift.id, {
        declaredCash: declaredCash || "0",
        declaredCard: "0",
        declaredMobileMoney: "0",
        declaredCredit: "0",
        declaredOther: "0",
      });
      setShift(null);
      setShiftMsg(`Shift closed — variance ${res.variance ?? "—"} (expected ${res.expectedTotal ?? "—"})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not close shift");
    } finally {
      setBusy(false);
    }
  };

  const doComplete = async () => {
    setBusy(true);
    setError(null);
    try {
      const hasMobile = tenders.some((t) => t.type === "mobile_money");
      const mobile = tenders.find((t) => t.type === "mobile_money");
      if (hasMobile && !mobile?.reference.trim()) {
        throw new Error("Enter the customer's mobile number for the mobile-money payment");
      }
      const wantsCredit = tenders.some((t) => t.type === "credit");
      const wantsLoyalty = Number(loyaltyPoints) > 0;
      if ((wantsCredit || wantsLoyalty) && !customerId) throw new Error("Select a customer account");
      const sale = await completeSale({
        branchId,
        lines: cart.map((l) => ({ variantId: l.variantId, quantity: String(l.qty) })),
        tenders: tenders.map((t) => ({
          tenderType: t.type,
          amount: t.amount,
          currency: t.currency,
          ...(t.reference ? { reference: t.reference } : {}),
        })),
        ...(customerId ? { customerId } : {}),
        ...(promoCode.trim() ? { promotionCode: promoCode.trim() } : {}),
        ...(Number(loyaltyPoints) > 0 ? { loyaltyRedeem: { points: Number(loyaltyPoints) } } : {}),
        ...(shift ? { shiftId: shift.id } : {}),
      });
      setReceipt(sale);
      setCart([]);
      setTenders([]);
      setPromoCode("");
      setLoyaltyPoints("");
      setCustomerId("");
      void loadSales();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete the sale");
    } finally {
      setBusy(false);
    }
  };

  const doRefund = async (sale: Record<string, unknown>) => {
    if (!window.confirm(`Refund ${fmtMoney(String(sale.total))} for sale ${String(sale.clientOperationId).slice(0, 8).toUpperCase()}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await refundSale(String(sale.id), String(sale.total));
      if (res.payout) {
        setShiftMsg(`Refunded — mobile-money payout of ${fmtMoney(String((res.payout as { amount: string }).amount))} initiated to wallet`);
      } else {
        setShiftMsg("Refund recorded");
      }
      void loadSales();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refund");
    } finally {
      setBusy(false);
    }
  };

  const viewSale = async (sale: Record<string, unknown>) => {
    try {
      setReceipt(await getSale(String(sale.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sale");
    }
  };

  const custMatches = customers.filter((c) => {
    const n = searchCust.toLowerCase();
    return !n || `${c.name} ${c.phone ?? ""}`.toLowerCase().includes(n);
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Till</h1>
          <div className="sub">
            Web POS client — sales price and reconcile server-side (prices, tax, stock) and are replay-safe by client operation id.
          </div>
        </div>
        <div className="btn-row" style={{ alignItems: "center" }}>
          <select className="input" style={{ width: 190 }} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {shift ? (
            <button
              className="btn"
              onClick={() => {
                const declared = window.prompt("Declared cash (P):", "0") ?? "0";
                void doCloseShift(declared);
              }}
              disabled={busy}
            >
              Close shift
            </button>
          ) : (
            <button
              className="btn"
              onClick={() => {
                const opening = window.prompt("Opening cash (P):", "0") ?? "0";
                void doOpenShift(opening);
              }}
              disabled={busy}
            >
              Open shift
            </button>
          )}
        </div>
      </div>

      {shiftMsg && (
        <div className="chip ok" style={{ marginBottom: 14, padding: "6px 12px" }} onClick={() => setShiftMsg(null)}>
          {shiftMsg} ✕
        </div>
      )}
      {error && <div className="err">{error}</div>}

      <div className="grid two">
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--sand-200)" }}>
            <input className="input" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))",
              gap: 8,
              padding: 12,
              maxHeight: 520,
              overflowY: "auto",
            }}
          >
            {filtered.length === 0 && <div className="empty">No products match.</div>}
            {filtered.map((p) => (
              <button
                key={p.variantId}
                className="btn"
                style={{ height: 74, display: "flex", flexDirection: "column", justifyContent: "space-between", alignItems: "flex-start", padding: 10 }}
                onClick={() => addProduct(p)}
              >
                <span style={{ fontSize: 12.5, fontWeight: 650, textAlign: "left", lineHeight: 1.25 }}>{p.productName}</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: "var(--green-700)" }}>{fmtMoney(p.price)}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h3>Cart · {fmtMoney(total)}</h3>
            {cart.length === 0 ? (
              <div className="empty">Tap products to add them.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <tbody>
                    {cart.map((l) => (
                      <tr key={l.variantId}>
                        <td style={{ fontWeight: 600 }}>{l.name}</td>
                        <td className="num">{fmtMoney(l.price)}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button className="btn" style={{ padding: "2px 9px", fontSize: 13 }} onClick={() => changeQty(l.variantId, -1)}>
                            −
                          </button>
                          <span style={{ display: "inline-block", minWidth: 34, textAlign: "center", fontWeight: 700 }}>{l.qty}</span>
                          <button className="btn" style={{ padding: "2px 9px", fontSize: 13 }} onClick={() => changeQty(l.variantId, 1)}>
                            +
                          </button>
                        </td>
                        <td className="num" style={{ fontWeight: 700 }}>
                          {fmtMoney(round2(Number(l.price) * l.qty))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h3>Tenders · {fmtMoney(tenderTotal)} {change >= 0 ? `· change ${fmtMoney(change)}` : "· short"}</h3>
            <div style={{ display: "grid", gap: 8 }}>
              {TENDER_TYPES.map((tt) => (
                <div key={tt.key} style={{ display: "grid", gridTemplateColumns: "110px 1fr auto", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 650 }}>{tt.label}</span>
                  <input
                    className="input"
                    type="number"
                    placeholder={tt.key === "mobile_money" ? "Amount" : "0.00"}
                    value={tenders.find((t) => t.type === tt.key)?.amount ?? ""}
                    onChange={(e) => setTenderAmount(tt.key, e.target.value, tenders.find((t) => t.type === tt.key)?.currency ?? baseCurrency)}
                  />
                  <select
                    className="input"
                    style={{ width: 90 }}
                    value={tenders.find((t) => t.type === tt.key)?.currency ?? baseCurrency}
                    onChange={(e) => setTenderAmount(tt.key, tenders.find((t) => t.type === tt.key)?.amount ?? "", e.target.value)}
                    disabled={tt.key === "mobile_money" || tt.key === "credit"}
                    title={tt.key === "mobile_money" || tt.key === "credit" ? "Must be in the base currency" : "Tender currency"}
                  >
                    {[baseCurrency, ...currencies.filter((c) => !c.isBase).map((c) => c.code)].map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              {tenders.some((t) => t.type === "mobile_money") && (
                <input
                  className="input"
                  placeholder="Customer's mobile number (e.g. +267 71 234 567)"
                  value={tenders.find((t) => t.type === "mobile_money")?.reference ?? ""}
                  onChange={(e) =>
                    setTenders((prev) =>
                      prev.map((t) => (t.type === "mobile_money" ? { ...t, reference: e.target.value } : t)),
                    )
                  }
                />
              )}
              {foreignTenders.length > 0 && (
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Foreign tenders convert at the day's rate; receipts show the foreign amount.
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <h3>Customer & discounts</h3>
            <div style={{ display: "grid", gap: 8 }}>
              <input className="input" placeholder="Search customers…" value={searchCust} onChange={(e) => setSearchCust(e.target.value)} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 96, overflowY: "auto" }}>
                {custMatches.map((c) => (
                  <button
                    key={c.id}
                    className={`btn ${customerId === c.id ? "active" : ""}`}
                    style={{ padding: "5px 12px", fontSize: 12.5 }}
                    onClick={() => setCustomerId(customerId === c.id ? "" : c.id)}
                    title={`${Number(c.loyaltyPoints).toLocaleString()} loyalty points`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              {selectedCustomer && (
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {selectedCustomer.name} — {Number(selectedCustomer.loyaltyPoints).toLocaleString()} pts
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input className="input" placeholder="Promo code (e.g. SAVE10)" value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase())} />
                <input
                  className="input"
                  type="number"
                  placeholder="Loyalty points to redeem"
                  value={loyaltyPoints}
                  onChange={(e) => setLoyaltyPoints(e.target.value)}
                  disabled={!customerId}
                />
              </div>
            </div>
          </div>

          <button className="btn primary" style={{ padding: 14, fontSize: 15 }} onClick={() => void doComplete()} disabled={busy || cart.length === 0 || tenderTotal < total}>
            Complete sale · {fmtMoney(total)}
          </button>
        </div>
      </div>

      <div style={{ height: 22 }} />

      <div className="card">
        <h3>Recent sales</h3>
        {sales.length === 0 ? (
          <div className="empty">No sales yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>When</th>
                  <th className="num">Total</th>
                  <th>Tenders</th>
                  <th>Payments</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => {
                  const tendersList = (s.tenders as { tenderType: string; amount: string }[]) ?? [];
                  const payments = (s.payments as { status: string }[]) ?? [];
                  const payouts = (s.payouts as { status: string }[]) ?? [];
                  return (
                    <tr key={String(s.id)}>
                      <td style={{ fontWeight: 600 }}>{String(s.clientOperationId).slice(0, 8).toUpperCase()}</td>
                      <td className="muted">{new Date(String(s.businessTime)).toLocaleString()}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {fmtMoney(String(s.total))}
                      </td>
                      <td>{tendersList.map((t) => t.tenderType).join(", ")}</td>
                      <td>
                        {payments.map((p) => (
                          <span key={p.status} className="chip pending" style={{ marginRight: 4 }}>
                            {p.status}
                          </span>
                        ))}
                        {payouts.map((p) => (
                          <span key={p.status} className="chip neutral" style={{ marginRight: 4 }}>
                            payout {p.status}
                          </span>
                        ))}
                      </td>
                      <td>
                        <div className="btn-row">
                          <button className="btn" style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => void viewSale(s)}>
                            View
                          </button>
                          {payments.some((p) => p.status === "confirmed") && (
                            <button className="btn" style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => void doRefund(s)} disabled={busy}>
                              Refund
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {receipt && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgb(31 42 36 / 45%)", display: "grid", placeItems: "center", padding: 24, zIndex: 20 }}
          onClick={() => setReceipt(null)}
        >
          <div className="card" style={{ width: "100%", maxWidth: 380, fontFamily: "ui-monospace, monospace" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ textAlign: "center", fontSize: 13 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>FlowWise</div>
              <div className="muted">Ref {String(receipt.clientOperationId).slice(0, 8).toUpperCase()}</div>
              <div className="muted">{new Date(String(receipt.businessTime)).toLocaleString()}</div>
            </div>
            <div style={{ borderTop: "1px dashed var(--sand-300)", margin: "12px 0", paddingTop: 10, fontSize: 13 }}>
              {((receipt.lines as { quantity: string; unitPrice: string; lineTotal: string; variantId: string }[]) ?? []).map((l) => (
                <div key={l.variantId} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>
                    {l.quantity} × {fmtMoney(l.unitPrice)}
                  </span>
                  <span>{fmtMoney(l.lineTotal)}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontWeight: 800 }}>
                <span>TOTAL</span>
                <span>{fmtMoney(String(receipt.total))}</span>
              </div>
              {((receipt.tenders as { tenderType: string; amount: string; amountFx?: string; tenderCurrency?: string }[]) ?? []).map((t) => (
                <div key={t.tenderType} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{t.tenderType}</span>
                  <span>{t.tenderCurrency && t.tenderCurrency !== baseCurrency ? `${t.amountFx} ${t.tenderCurrency}` : fmtMoney(t.amount)}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Change</span>
                <span>{fmtMoney(String(receipt.changeDue))}</span>
              </div>
            </div>
            <button className="btn" style={{ width: "100%" }} onClick={() => window.print()}>
              Print
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
