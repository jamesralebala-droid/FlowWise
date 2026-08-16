import { useCallback, useEffect, useState } from "react";
import { api, fmtMoney, fmtPct } from "../api";

interface Promotion {
  id: string;
  code: string;
  name: string;
  discountType: "percentage" | "amount";
  discountValue: string;
  minSpend: string | null;
  usageLimit: number | null;
  timesUsed: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  updatedAt: string;
}

type FormState = {
  code: string;
  name: string;
  discountType: "percentage" | "amount";
  discountValue: string;
  minSpend: string;
  usageLimit: string;
  isActive: boolean;
  endsAt: string;
};

const EMPTY_FORM: FormState = {
  code: "",
  name: "",
  discountType: "percentage",
  discountValue: "",
  minSpend: "",
  usageLimit: "",
  isActive: true,
  endsAt: "",
};

function discountLabel(p: { discountType: Promotion["discountType"]; discountValue: string }): string {
  return p.discountType === "percentage" ? fmtPct(p.discountValue) : fmtMoney(p.discountValue);
}

export default function Promotions() {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ promotions: Promotion[] }>("/promotions");
      setPromotions(res.promotions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load promotions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
  };

  const openEdit = (p: Promotion) => {
    setEditing(p);
    setForm({
      code: p.code,
      name: p.name,
      discountType: p.discountType,
      discountValue: p.discountValue,
      minSpend: p.minSpend ?? "",
      usageLimit: p.usageLimit ? String(p.usageLimit) : "",
      isActive: p.isActive,
      endsAt: p.endsAt ? p.endsAt.slice(0, 16) : "",
    });
    setSaveError(null);
  };

  const close = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
  };

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = {
        code: form.code,
        name: form.name,
        discountType: form.discountType,
        discountValue: form.discountValue,
        minSpend: form.minSpend || undefined,
        usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
        isActive: form.isActive,
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      };
      if (editing) {
        await api(`/promotions/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/promotions", { method: "POST", body: JSON.stringify(body) });
      }
      close();
      await load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save the promotion");
    } finally {
      setSaving(false);
    }
  };

  const activeNow = (p: Promotion) =>
    p.isActive && (!p.endsAt || new Date(p.endsAt).getTime() >= Date.now());

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Promotions & discounts</h1>
          <div className="sub">Percentage or amount-off codes, min-spend rules and usage caps. Entered at the till with the promo code.</div>
        </div>
        <button className="btn primary" onClick={openCreate}>
          + New promotion
        </button>
      </div>

      {error && <div className="err">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="loading">Loading promotions…</div>
        ) : promotions.length === 0 ? (
          <div className="empty">No promotions yet — create your first discount code above.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th className="num">Discount</th>
                  <th className="num">Min spend</th>
                  <th className="num">Usage</th>
                  <th>Window</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {promotions.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 700, letterSpacing: "0.03em" }}>{p.code}</td>
                    <td>{p.name}</td>
                    <td className="num">{discountLabel(p)}</td>
                    <td className="num muted">{p.minSpend && Number(p.minSpend) > 0 ? fmtMoney(p.minSpend) : "—"}</td>
                    <td className="num muted">
                      {p.usageLimit ? `${p.timesUsed} / ${p.usageLimit}` : p.timesUsed}
                    </td>
                    <td className="muted">{p.endsAt ? `until ${new Date(p.endsAt).toLocaleDateString()}` : "ongoing"}</td>
                    <td>
                      {activeNow(p) ? <span className="chip ok">active</span> : <span className="chip neutral">paused</span>}
                    </td>
                    <td>
                      <button className="btn" style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => openEdit(p)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing !== undefined && (
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
          onClick={close}
        >
          <div className="card" style={{ width: "100%", maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="page-head">
              <div>
                <h1 style={{ fontSize: 20 }}>{editing ? `Edit ${editing.code}` : "New promotion"}</h1>
                <div className="sub">Codes are case-insensitive and shown in uppercase at the till.</div>
              </div>
              <button className="btn" onClick={close}>
                Close
              </button>
            </div>

            {saveError && <div className="err">{saveError}</div>}

            <div style={{ display: "grid", gap: 12 }}>
              <div className="field-row">
                <label className="field">
                  <span>Code</span>
                  <input className="input" value={form.code} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="SAVE10" />
                </label>
                <label className="field">
                  <span>Name</span>
                  <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="10% off everything" />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>Discount type</span>
                  <select className="input" value={form.discountType} onChange={(e) => set("discountType", e.target.value as FormState["discountType"])}>
                    <option value="percentage">Percentage (%)</option>
                    <option value="amount">Fixed amount (P)</option>
                  </select>
                </label>
                <label className="field">
                  <span>{form.discountType === "percentage" ? "Discount (%)" : "Discount (P)"}</span>
                  <input
                    className="input"
                    value={form.discountValue}
                    onChange={(e) => set("discountValue", e.target.value)}
                    placeholder={form.discountType === "percentage" ? "10" : "15.00"}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>Min spend (P)</span>
                  <input className="input" value={form.minSpend} onChange={(e) => set("minSpend", e.target.value)} placeholder="0.00" />
                </label>
                <label className="field">
                  <span>Usage limit</span>
                  <input className="input" value={form.usageLimit} onChange={(e) => set("usageLimit", e.target.value)} placeholder="unlimited" />
                </label>
              </div>

              <label className="field">
                <span>Ends at</span>
                <input className="input" type="datetime-local" value={form.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
                Active (redeemable at the till)
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button className="btn" onClick={close}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : editing ? "Save changes" : "Create promotion"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
