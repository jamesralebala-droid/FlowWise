import { useEffect, useState } from "react";
import { supplierApi } from "../../api";

interface SupplierMe {
  name: string;
  email: string;
  supplierName: string;
  supplierCode: string;
  contactName: string | null;
  contactPhone: string | null;
  supplierEmail: string | null;
}

export default function SupplierProfile() {
  const [me, setMe] = useState<SupplierMe | null>(null);
  const [form, setForm] = useState({ name: "", contactPhone: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    supplierApi<SupplierMe>("/me")
      .then((m) => {
        if (!alive) return;
        setMe(m);
        setForm({ name: m.name ?? "", contactPhone: m.contactPhone ?? "", email: m.supplierEmail ?? "" });
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not load profile"));
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await supplierApi("/me", {
        method: "PUT",
        body: JSON.stringify({ name: form.name, contactPhone: form.contactPhone, email: form.email }),
      });
      setMsg("Profile updated.");
      const m = await supplierApi<SupplierMe>("/me");
      setMe(m);
      setForm({ name: m.name ?? "", contactPhone: m.contactPhone ?? "", email: m.supplierEmail ?? "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the profile");
    } finally {
      setBusy(false);
    }
  };

  if (!me) {
    return <div className="loading">{error ?? "Loading…"}</div>;
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <div className="sub">
            {me.supplierName} ({me.supplierCode}) — how the branch reaches you.
          </div>
        </div>
      </div>

      {msg && (
        <div className="chip ok" style={{ marginBottom: 14, padding: "6px 12px" }}>
          {msg}
        </div>
      )}
      {error && <div className="err">{error}</div>}

      <div className="card" style={{ maxWidth: 520 }}>
        <div style={{ display: "grid", gap: 12 }}>
          <label className="field">
            <span>Contact person</span>
            <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </label>
          <label className="field">
            <span>Phone</span>
            <input className="input" value={form.contactPhone} onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))} />
          </label>
          <label className="field">
            <span>Email</span>
            <input className="input" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </label>
          <div>
            <button className="btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
