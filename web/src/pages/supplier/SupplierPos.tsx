import { useCallback, useEffect, useState } from "react";
import { fmtMoney, supplierApi } from "../../api";

interface DeliveryNoteResult {
  id: string;
  documentNo: string;
  status: string;
}

interface PoLine {
  lineNo: number;
  variantId: string;
  variantName: string;
  productName: string;
  quantity: string;
  unitCost: string;
  receivedQuantity: string;
  outstandingQuantity: string;
}

interface PurchaseOrder {
  id: string;
  documentNo: string;
  status: string;
  branchName: string;
  createdAt: string;
  sentAt: string | null;
  expectedDelivery: string | null;
  lines: PoLine[];
}

const STATUS_CHIP: Record<string, string> = {
  sent: "pending",
  partially_received: "pending",
  received: "ok",
  cancelled: "bad",
};

export default function SupplierPos() {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deliveryDrafts, setDeliveryDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [deliveryMsg, setDeliveryMsg] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await supplierApi<{ purchaseOrders: PurchaseOrder[] }>("/purchase-orders");
      setPos(res.purchaseOrders);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load purchase orders");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Purchase orders</h1>
          <div className="sub">Orders FlowWise has sent you. Outstanding quantities update as deliveries are received at the branch.</div>
        </div>
      </div>

      {error && <div className="err">{error}</div>}
      {loading ? (
        <div className="loading">Loading…</div>
      ) : pos.length === 0 ? (
        <div className="card">
          <div className="empty">No purchase orders yet — when FlowWise sends you one it will appear here.</div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Branch</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Expected delivery</th>
                  <th>Lines</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pos.map((po) => {
                  return (
                    <tr key={po.id}>
                      <td style={{ fontWeight: 700 }}>{po.documentNo}</td>
                      <td>{po.branchName}</td>
                      <td>
                        <span className={`chip ${STATUS_CHIP[po.status] ?? "neutral"}`}>{po.status.replace("_", " ")}</span>
                      </td>
                      <td className="muted">{new Date(po.createdAt).toLocaleDateString()}</td>
                      <td className="muted">{po.expectedDelivery ?? "—"}</td>
                      <td className="num">{po.lines.length}</td>
                      <td>
                        <button className="btn" style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => setSelected(po)}>
                          Lines
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selected && (
        <div style={{ position: "fixed", inset: 0, background: "rgb(31 42 36 / 45%)", display: "grid", placeItems: "center", padding: 24, zIndex: 20 }} onClick={() => setSelected(null)}>
          <div className="card" style={{ width: "100%", maxWidth: 640, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div className="page-head">
              <div>
                <h1 style={{ fontSize: 20 }}>{selected.documentNo}</h1>
                <div className="sub">
                  {selected.branchName} · {selected.status.replace("_", " ")}
                </div>
              </div>
              <button className="btn" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Product</th>
                    <th className="num">Qty</th>
                    <th className="num">Unit cost</th>
                    <th className="num">Received</th>
                    <th className="num">Outstanding</th>
                    <th>Deliver</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className="muted">{l.lineNo}</td>
                      <td style={{ fontWeight: 600 }}>
                        {l.productName} · {l.variantName}
                      </td>
                      <td className="num">{l.quantity}</td>
                      <td className="num">{fmtMoney(l.unitCost)}</td>
                      <td className="num">{l.receivedQuantity}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {l.outstandingQuantity}
                      </td>
                      <td style={{ width: 110 }}>
                        <input
                          className="input"
                          type="number"
                          max={l.outstandingQuantity}
                          placeholder={l.outstandingQuantity}
                          value={deliveryDrafts[l.variantId] ?? ""}
                          onChange={(e) => setDeliveryDrafts((d) => ({ ...d, [l.variantId]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {deliveryMsg && (
              <div className="chip ok" style={{ marginTop: 14, padding: "6px 12px" }}>
                {deliveryMsg}
              </div>
            )}
            {deliveryError && <div className="err">{deliveryError}</div>}

            {(selected.status === "sent" || selected.status === "partially_received") && (
              <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
                <button
                  className="btn primary"
                  disabled={submitting || Object.values(deliveryDrafts).every((v) => !v)}
                  onClick={() => void submitDelivery(selected, deliveryDrafts, setSubmitting, setDeliveryMsg, setDeliveryError, setDeliveryDrafts)}
                >
                  {submitting ? "Submitting…" : "Submit delivery note"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

async function submitDelivery(
  po: PurchaseOrder,
  drafts: Record<string, string>,
  setSubmitting: (v: boolean) => void,
  setMsg: (v: string | null) => void,
  setError: (v: string | null) => void,
  setDrafts: (d: Record<string, string>) => void,
): Promise<void> {
  const lines = Object.entries(drafts)
    .filter(([, qty]) => qty && Number(qty) > 0)
    .map(([variantId, quantity]) => ({ variantId, quantity }));
  if (lines.length === 0) return;
  setSubmitting(true);
  setMsg(null);
  setError(null);
  try {
    const res = await supplierApi<DeliveryNoteResult>("/delivery-notes", {
      method: "POST",
      body: JSON.stringify({ poId: po.id, lines, notes: `Delivery for ${po.documentNo}` }),
    });
    setDrafts({});
    setMsg(`Delivery note ${res.documentNo} submitted — the branch reviews and posts it into stock.`);
  } catch (e) {
    setError(e instanceof Error ? e.message : "Could not submit the delivery note");
  } finally {
    setSubmitting(false);
  }
}
