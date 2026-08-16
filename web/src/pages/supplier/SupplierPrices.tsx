import { useCallback, useEffect, useState } from "react";
import { fmtMoney, supplierApi } from "../../api";

interface PriceItem {
  variantId: string;
  supplierSku: string | null;
  unitCost: string | null;
  isDefault: boolean;
  variantName: string;
  productName: string;
  sku: string | null;
}

export default function SupplierPrices() {
  const [items, setItems] = useState<PriceItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await supplierApi<{ items: PriceItem[] }>("/price-list");
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your price list");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (item: PriceItem) => {
    const value = drafts[item.variantId] ?? "";
    if (!value) return;
    setSaving(item.variantId);
    setError(null);
    setMsg(null);
    try {
      await supplierApi(`/price-list/${item.variantId}`, { method: "PUT", body: JSON.stringify({ unitCost: value }) });
      setDrafts((d) => {
        const next = { ...d };
        delete next[item.variantId];
        return next;
      });
      setMsg(`Saved ${item.productName} at ${fmtMoney(value)} — the branch sees it on the next GRN/PO.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the price");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>My price list</h1>
          <div className="sub">These are your quoted costs. FlowWise uses them as the cost basis for GRNs and purchase orders — keep them current so margins stay accurate.</div>
        </div>
      </div>

      {msg && (
        <div className="chip ok" style={{ marginBottom: 14, padding: "6px 12px" }}>
          {msg}
        </div>
      )}
      {error && <div className="err">{error}</div>}

      <div className="card">
        {items.length === 0 ? (
          <div className="empty">No products mapped to your account yet — ask the branch to map your catalogue.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Your SKU</th>
                  <th className="num">Current cost</th>
                  <th>New cost</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.variantId}>
                    <td style={{ fontWeight: 600 }}>
                      {item.productName} · {item.variantName}
                    </td>
                    <td className="muted">{item.supplierSku ?? "—"}</td>
                    <td className="num">{item.unitCost ? fmtMoney(item.unitCost) : "—"}</td>
                    <td style={{ width: 160 }}>
                      <input
                        className="input"
                        type="number"
                        step="0.01"
                        placeholder={item.unitCost ?? "0.00"}
                        value={drafts[item.variantId] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [item.variantId]: e.target.value }))}
                      />
                    </td>
                    <td>
                      <button
                        className="btn primary"
                        style={{ padding: "6px 14px", fontSize: 13 }}
                        disabled={!drafts[item.variantId] || saving === item.variantId}
                        onClick={() => void save(item)}
                      >
                        {saving === item.variantId ? "Saving…" : "Save"}
                      </button>
                    </td>
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
