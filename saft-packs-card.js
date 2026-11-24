/*
 * Saft packs overview card — one Lovelace card for a bank of parallel battery
 * packs, each with its own BMS (JBD over BLE via ESPHome, or anything that
 * exposes the same sensors).
 *
 *   custom:saft-packs-card
 *
 * Bank totals (power, current, voltage, SOC, stored Ah, time to full/empty,
 * cell extremes, temperatures) are computed only from packs that are
 * operational: reporting recently and with their FETs closed. Every pack gets a
 * tile showing its SOC, current and status.
 *
 * Styling matches krogo energy cards (github.com/krogo/HACS_Solark_Batrium_Emporia_Flow).
 */

const VERSION = "1.0.0";

/* ------------------------------------------------------------------ helpers */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Entity spec may be "sensor.x" or { entity, invert, name, icon }. */
const spec = (s) => (s == null ? null : typeof s === "string" ? { entity: s } : s);

function stateObj(hass, s) {
  s = spec(s);
  return s && hass ? hass.states[s.entity] : undefined;
}

/** Numeric value, or null if missing/unavailable. Applies `invert`. */
function num(hass, s) {
  const st = stateObj(hass, s);
  if (!st) return null;
  const v = parseFloat(st.state);
  if (!isFinite(v)) return null;
  return spec(s).invert ? -v : v;
}

const unitOf = (hass, s) => (stateObj(hass, s)?.attributes?.unit_of_measurement || "").trim();

/** Power in W regardless of source unit. */
function watts(hass, s) {
  const v = num(hass, s);
  if (v == null) return null;
  const u = unitOf(hass, s).toLowerCase();
  return u === "kw" ? v * 1000 : u === "mw" ? v * 1e6 : v;
}

/** Voltage in V regardless of source unit. */
function volts(hass, s) {
  const v = num(hass, s);
  if (v == null) return null;
  return unitOf(hass, s).toLowerCase() === "mv" ? v / 1000 : v;
}

/** Temperature as { v, unit } in whatever unit HA reports (°C or °F). */
function temp(hass, s) {
  const v = num(hass, s);
  return { v, unit: unitOf(hass, s) || "°C" };
}

/** Energy in kWh regardless of source unit. */
function kwh(hass, s) {
  const v = num(hass, s);
  if (v == null) return null;
  const u = unitOf(hass, s).toLowerCase();
  return u === "wh" ? v / 1000 : u === "mwh" ? v * 1000 : v;
}

function fmtPower(w, { signed = false } = {}) {
  if (w == null) return "—";
  const a = Math.abs(w);
  const sign = signed && w < 0 ? "−" : "";
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(a >= 10000 ? 1 : 2)} kW`;
  return `${sign}${Math.round(a)} W`;
}

const fmt = (v, d = 1, unit = "") => (v == null ? "—" : `${v.toFixed(d)}${unit ? " " + unit : ""}`);

function fmtMinutes(m) {
  if (m == null || m < 0) return null;
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  if (h >= 48) return `${Math.round(h / 24)}d`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Opens HA's more-info dialog for an entity. */
function moreInfo(el, entityId) {
  if (!entityId) return;
  el.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
}

/** SVG ring (stroke-dasharray arc). pct 0..100. */
function ring(pct, { size = 112, stroke = 10, color = "var(--kec-accent)", track = "var(--kec-track)" } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const p = pct == null ? 0 : clamp(pct, 0, 100);
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${(c * p) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
  </svg>`;
}

/* ------------------------------------------------------------- shared style */

const STYLE = `
  :host {
    --kec-accent: var(--accent-color, var(--primary-color));
    --kec-solar: var(--energy-solar-color, #ff9800);
    --kec-grid-in: var(--energy-grid-consumption-color, #488fc2);
    --kec-grid-out: var(--energy-grid-return-color, #8353d1);
    --kec-batt-in: var(--energy-battery-in-color, #f06292);
    --kec-batt-out: var(--energy-battery-out-color, #4db6ac);
    --kec-home: var(--primary-color, #03a9f4);
    --kec-ok: var(--success-color, #43a047);
    --kec-warn: var(--warning-color, #ffa600);
    --kec-bad: var(--error-color, #db4437);
    --kec-track: var(--divider-color, rgba(127,127,127,.25));
    --kec-muted: var(--secondary-text-color);
    --kec-tile: rgba(127,127,127,.08);
    display: block;
  }
  ha-card { padding: 14px 16px 16px; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .head .title { font-size: 1.05rem; font-weight: 500; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .head ha-icon { color: var(--kec-muted); --mdc-icon-size: 20px; }
  .chip { font-size: .75rem; font-weight: 500; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
          background: color-mix(in srgb, var(--chip, var(--kec-muted)) 18%, transparent); color: var(--chip, var(--kec-muted)); }
  .lbl { font-size: .72rem; letter-spacing: .04em; text-transform: uppercase; color: var(--kec-muted); }
  .val { font-size: 1.05rem; font-weight: 500; font-variant-numeric: tabular-nums; }
  .val small { font-size: .75rem; font-weight: 400; color: var(--kec-muted); margin-left: 2px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
  .tile { background: var(--kec-tile); border-radius: 12px; padding: 8px 10px; cursor: pointer; min-width: 0; }
  .tile:hover { background: color-mix(in srgb, var(--kec-tile) 100%, var(--primary-text-color) 6%); }
  .tile .lbl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .section { margin-top: 14px; }
  .section > .lbl { display: block; margin-bottom: 6px; }
  .bar { height: 6px; border-radius: 3px; background: var(--kec-track); overflow: hidden; position: relative; }
  .bar > i { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; background: var(--c, var(--kec-accent)); }
  .click { cursor: pointer; }
  .muted { color: var(--kec-muted); }
  .warn { color: var(--kec-warn); } .bad { color: var(--kec-bad); }
`;

/* ---------------------------------------------------------------- base card */

class KecBase extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._sig = null;
  }
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this.validate(config);
    this._config = config;
    this._sig = null;
    if (this._hass) this._render(true);
  }
  validate() {}
  set hass(hass) {
    this._hass = hass;
    this._render(false);
  }
  get hass() { return this._hass; }
  /** Entity ids this card reads; used to skip renders when nothing changed. */
  watched() { return []; }
  _render(force) {
    if (!this._config || !this._hass) return;
    const sig = this.watched().map((e) => {
      const s = this._hass.states[e];
      return s ? s.state + "|" + (s.attributes.unit_of_measurement || "") : "~";
    }).join(",");
    if (!force && sig === this._sig) return;
    this._sig = sig;
    this.update();
  }
  /** True when no entity is configured yet (fresh card from the picker). */
  isEmpty() { return false; }
  _hint() {
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="head"><ha-icon icon="mdi:pencil"></ha-icon>
      <div class="title">${esc(this.constructor.label || "Card")}</div></div>
      <div class="muted">No sensors set yet. Open the card editor to choose them, or paste a YAML example from the README.</div></ha-card>`;
  }
  /** Full re-render. Subclasses with animations override to patch in place. */
  update() {
    if (this.isEmpty()) { this._built = false; return this._hint(); }
    this.shadowRoot.innerHTML = `<style>${STYLE}${this.css ? this.css() : ""}</style>${this.html()}`;
    this.shadowRoot.querySelectorAll("[data-entity]").forEach((el) =>
      el.addEventListener("click", (ev) => { ev.stopPropagation(); moreInfo(this, el.dataset.entity); }));
    if (this.bind) this.bind();
  }
  getCardSize() { return 4; }
}

const eid = (s) => spec(s)?.entity || "";
const ids = (...specs) => specs.flat().map(eid).filter(Boolean);

/* ------------------------------------------------------------ visual editor */
/*
 * HA's ha-form edits flat data, and its expandable groups don't nest values.
 * The cards use nested config (battery: { entity, invert, soc }), so the editor
 * maps each form field to a path in the config and translates both ways.
 * Anything the editor doesn't know about (custom names, lists it doesn't show)
 * is left untouched.
 */

const S_POWER = { entity: { filter: [{ domain: "sensor" }] } };
const S_ENT = { entity: {} };
const S_BOOL = { boolean: {} };
const S_TEXT = { text: {} };
const S_ICON = { icon: {} };
const S_NUM = (min, max, step = 1, unit) => ({ number: { min, max, step, mode: "box", ...(unit ? { unit_of_measurement: unit } : {}) } });

/** Read a path; a plain "sensor.x" string stands in for { entity: "sensor.x" }. */
function getPath(obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length; i++) {
    const k = path[i];
    if (cur == null) return undefined;
    if (typeof cur === "string") return k === "entity" && i === path.length - 1 ? cur : undefined;
    cur = cur[k];
  }
  return cur;
}

/** Write a path immutably; empty values remove the key; { entity } alone collapses to a string. */
function setPath(obj, path, value) {
  const empty = value === undefined || value === null || value === "" || value === false;
  const rec = (node, i) => {
    const k = path[i];
    if (typeof node === "string") node = { entity: node };
    const base = Array.isArray(node) ? [...node] : node == null && typeof k === "number" ? [] : { ...(node || {}) };
    if (i === path.length - 1) {
      if (empty) { if (Array.isArray(base)) base[k] = undefined; else delete base[k]; }
      else base[k] = value;
    } else {
      const child = rec(base[k], i + 1);
      if (child === undefined) { if (Array.isArray(base)) base[k] = undefined; else delete base[k]; }
      else base[k] = child;
    }
    if (Array.isArray(base)) {
      while (base.length && base[base.length - 1] === undefined) base.pop();
      return base.length ? base : undefined;
    }
    const keys = Object.keys(base);
    if (!keys.length) return undefined;
    if (keys.length === 1 && keys[0] === "entity" && typeof base.entity === "string") return base.entity;
    // A list item left holding only a name (its sensor was cleared) is dropped too.
    if (!("entity" in base) && keys.every((x) => x === "name") && path.some((x) => typeof x === "number")) return undefined;
    return base;
  };
  return rec(obj, 0) ?? {};
}

class KecEditor extends HTMLElement {
  /** fields: [{ key, path, selector, label, helper?, group? }] */
  static fields = [];
  setConfig(config) { this._config = config; this._render(); }
  set hass(hass) { this._hass = hass; if (this._form) this._form.hass = hass; else this._render(); }
  _fields() { return this.constructor.fields; }
  _schema() {
    const groups = [];
    const byGroup = new Map();
    for (const f of this._fields()) {
      const item = { name: f.key, selector: f.selector };
      if (!f.group) { groups.push(item); continue; }
      if (!byGroup.has(f.group)) {
        const g = { type: "expandable", name: "", title: f.group, schema: [] };
        byGroup.set(f.group, g); groups.push(g);
      }
      byGroup.get(f.group).schema.push(item);
    }
    return groups;
  }
  _data() {
    const d = {};
    for (const f of this._fields()) {
      const v = f.get ? f.get(this._config) : getPath(this._config, f.path);
      if (v !== undefined) d[f.key] = v;
    }
    return d;
  }
  _render() {
    if (!this._config || !this._hass) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      const labels = Object.fromEntries(this._fields().map((f) => [f.key, f]));
      this._form.computeLabel = (s) => labels[s.name]?.label ?? s.title ?? s.name;
      this._form.computeHelper = (s) => labels[s.name]?.helper;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const data = ev.detail.value || {};
        let cfg = { ...this._config };
        for (const f of this._fields()) {
          const before = f.get ? f.get(this._config) : getPath(this._config, f.path);
          if (data[f.key] === before) continue;
          cfg = f.set ? f.set(cfg, data[f.key]) : setPath(cfg, f.path, data[f.key]);
        }
        this._config = cfg;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: cfg }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = this._schema();
    this._form.data = this._data();
  }
}

const F = (key, path, selector, label, group, helper) => ({ key, path, selector, label, group, helper });

/* ----------------------------------------------------------- pack discovery */
/*
 * Each pack's sensors are found by id: an entity whose id ends in
 * `<match with {n}>` + key, e.g. sensor.saft_bank_a_saft_3_total_voltage for
 * match "saft_{n}_" and key "total_voltage". The ESP that a pack hangs off
 * (saft_bank_a / saft_bank_b) doesn't matter, so packs can move between ESPs.
 * A trailing _2, _3 … (HA's de-duplication suffix) is accepted.
 */
const KEYS = {
  voltage: ["total_voltage"],
  current: ["current"],
  power: ["power"],
  soc: ["soc", "state_of_charge"],
  cell_avg: ["avg_cell_v", "average_cell_voltage"],
  cell_delta: ["delta_cell_v", "delta_cell_voltage"],
  cell_min: ["min_cell_v", "min_cell_voltage"],
  cell_max: ["max_cell_v", "max_cell_voltage"],
  cell_min_n: ["min_cell", "min_voltage_cell"],
  cell_max_n: ["max_cell", "max_voltage_cell"],
  temp_1: ["temp_1", "temperature_1"],
  temp_2: ["temp_2", "temperature_2"],
  capacity: ["nominal_capacity"],
  remaining: ["capacity_remaining"],
  cycles: ["charging_cycles", "cycles"],
  online: ["online", "online_status"],
  charging: ["charging"],
  discharging: ["discharging"],
  balancing: ["balancing"],
  errors: ["errors"],
};
// Sensors whose last_updated says when the pack last reported (they change on almost every reading).
const FRESH_KEYS = ["voltage", "current", "power", "cell_avg", "cell_delta", "cell_min", "cell_max", "soc"];

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** { n -> { key -> entity_id } } for packs 1..count. Cached until the entity list changes. */
function discover(hass, match, count, overrides = {}) {
  const all = Object.keys(hass.states);
  const out = {};
  for (let n = 1; n <= count; n++) {
    const prefix = match.replace("{n}", n);
    const e = {};
    for (const [key, names] of Object.entries(KEYS)) {
      for (const nm of names) {
        const re = new RegExp(`(^|[._])${reEsc(prefix + nm)}(_\\d+)?$`);
        const hits = all.filter((id) => re.test(id));
        if (hits.length) { e[key] = hits.sort((a, b) => a.length - b.length)[0]; break; }
      }
    }
    Object.assign(e, overrides[n] || {});
    out[n] = e;
  }
  return out;
}

const ts = (hass, id) => Date.parse(hass.states[id]?.last_updated || 0) || 0;
const isUnavail = (hass, id) => !id || !hass.states[id] || ["unavailable", "unknown", ""].includes(hass.states[id].state);

/** Status and values for one pack. */
function packInfo(hass, n, e, cfg, now) {
  const p = { n, e, name: cfg.names?.[n] ?? `${n}` };
  if (!e.soc && !e.voltage) return { ...p, status: "absent" };
  p.soc = num(hass, e.soc);
  p.v = volts(hass, e.voltage);
  p.i = num(hass, e.current);
  p.w = watts(hass, e.power) ?? (p.v != null && p.i != null ? p.v * p.i : null);
  p.cmin = volts(hass, e.cell_min); p.cmax = volts(hass, e.cell_max);
  p.cminN = num(hass, e.cell_min_n); p.cmaxN = num(hass, e.cell_max_n);
  p.delta = volts(hass, e.cell_delta) ?? (p.cmin != null && p.cmax != null ? p.cmax - p.cmin : null);
  const t1 = temp(hass, e.temp_1), t2 = temp(hass, e.temp_2);
  p.temps = [t1.v, t2.v].filter((x) => x != null); p.tunit = e.temp_1 ? t1.unit : t2.unit;
  p.cap = num(hass, e.capacity) ?? cfg.capacity_ah ?? null;
  p.rem = num(hass, e.remaining) ?? (p.cap != null && p.soc != null ? (p.cap * p.soc) / 100 : null);
  p.cycles = num(hass, e.cycles);
  p.balancing = hass.states[e.balancing]?.state === "on";
  const err = hass.states[e.errors]?.state;
  p.error = err && !["", "unknown", "unavailable", "Offline", "None", "No errors"].includes(err) ? err : null;
  p.updated = Math.max(0, ...FRESH_KEYS.map((k) => (e[k] ? ts(hass, e[k]) : 0)));
  p.age = p.updated ? (now - p.updated) / 60000 : null;

  const fetOff = e.charging && e.discharging && hass.states[e.charging]?.state === "off" && hass.states[e.discharging]?.state === "off";
  if (hass.states[e.online]?.state === "off" || (isUnavail(hass, e.voltage) && isUnavail(hass, e.soc))) p.status = "offline";
  else if (p.age == null || p.age > (cfg.stale_after ?? 10)) p.status = "stale";
  else if (fetOff) p.status = "isolated";
  else p.status = p.error ? "fault" : "ok";
  // Operational = reporting recently and connected to the bus (a fault with FETs closed still counts).
  p.op = p.status === "ok" || p.status === "fault";
  return p;
}

const STATUS = {
  ok: ["", "var(--kec-ok)"],
  fault: ["Fault", "var(--kec-bad)"],
  isolated: ["FETs off", "var(--kec-warn)"],
  stale: ["Stale", "var(--kec-warn)"],
  offline: ["Offline", "var(--kec-bad)"],
  absent: ["Empty slot", "var(--kec-muted)"],
};

const ago = (m) => (m == null ? "—" : m < 1 ? "<1m" : m < 60 ? `${Math.round(m)}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`);

/* ----------------------------------------------------------- the card */
/*
 * type: custom:saft-packs-card
 * name: Saft bank
 * count: 12                 # packs 1..count; ones with no sensors show as "not installed"
 * match: "saft_{n}_"        # id fragment before each key; {n} = pack number
 * capacity_ah: 50           # per pack, used when the BMS doesn't expose nominal_capacity
 * stale_after: 10           # minutes without a new reading before a pack is left out
 * cell_range: [3.0, 4.2]
 * spread_warn: 0.05         # V
 * idle_threshold: 20        # W
 * names: { 1: "A1" }        # optional tile labels
 * entities: { 3: { soc: sensor.other_soc } }   # optional per-pack overrides
 */
class SaftPacksCard extends KecBase {
  static label = "Saft packs";
  connectedCallback() {
    // Pack ages move with the clock, not only with state changes.
    this._tick = setInterval(() => this._render(true), 30000);
  }
  disconnectedCallback() { clearInterval(this._tick); }
  _packs() {
    const c = this._config, h = this._hass;
    const key = `${Object.keys(h.states).length}|${c.match}|${c.count}|${JSON.stringify(c.entities || {})}`;
    if (key !== this._dkey) { this._dkey = key; this._map = discover(h, c.match ?? "saft_{n}_", c.count ?? 12, c.entities); }
    return this._map;
  }
  watched() { return Object.values(this._packs()).flatMap((e) => Object.values(e)); }
  getCardSize() { return 8; }
  getGridOptions() { return { columns: 12, min_columns: 6, rows: "auto" }; }
  css() {
    return `
      .top { display: grid; grid-template-columns: auto 1fr; gap: 14px; align-items: center; }
      .socwrap { position: relative; width: 112px; height: 112px; }
      .socwrap .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
      .socwrap .pct { font-size: 1.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
      .socwrap .pct small { font-size: .9rem; font-weight: 400; color: var(--kec-muted); }
      .socwrap .sub { font-size: .75rem; color: var(--kec-muted); }
      .kv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .kv .tile { cursor: default; }
      .kv .tile:hover { background: var(--kec-tile); }
      .spread { display: flex; align-items: center; gap: 10px; }
      .spread .rng { flex: 1; position: relative; height: 22px; }
      .spread .rng .bar { position: absolute; left: 0; right: 0; top: 8px; }
      .spread .rng .band { position: absolute; top: 4px; height: 14px; border-radius: 7px; background: var(--c); opacity: .85; min-width: 4px; }
      .note { font-size: .72rem; color: var(--kec-muted); text-align: center; margin-top: 2px; }
      .packs { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 6px; }
      .pk { border-radius: 10px; padding: 6px 7px 7px; background: var(--kec-tile); cursor: pointer; min-width: 0;
            border: 1px solid transparent; position: relative; }
      .pk:hover { background: color-mix(in srgb, var(--kec-tile) 100%, var(--primary-text-color) 6%); }
      .pk.out { border-color: color-mix(in srgb, var(--st) 55%, transparent); }
      .pk.absent { background: none; border: 1px dashed var(--kec-track); cursor: default; }
      .pk .row1 { display: flex; align-items: center; justify-content: space-between; font-size: .7rem; color: var(--kec-muted); }
      .pk .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--st); }
      .pk .soc { font-size: 1rem; font-weight: 600; font-variant-numeric: tabular-nums; margin: 1px 0 3px; }
      .pk .soc small { font-size: .7rem; font-weight: 400; color: var(--kec-muted); }
      .pk.out .soc, .pk.absent .soc { color: var(--kec-muted); }
      .pk .bar { height: 4px; }
      .pk .amps { font-size: .7rem; font-variant-numeric: tabular-nums; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pk .st { font-size: .66rem; color: var(--st); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 4px; }
      .legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: .7rem; color: var(--kec-muted); margin-top: 6px; }
      .legend i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--st); margin-right: 4px; }
      .alarm { margin-top: 10px; padding: 8px 10px; border-radius: 10px; font-size: .8rem;
               background: color-mix(in srgb, var(--kec-bad) 14%, transparent); color: var(--kec-bad); }
    `;
  }
  html() {
    const c = this._config, h = this._hass, now = Date.now();
    const idle = c.idle_threshold ?? 20;
    const map = this._packs();
    const packs = Object.entries(map).map(([n, e]) => packInfo(h, +n, e, c, now));
    const present = packs.filter((p) => p.status !== "absent");
    const op = packs.filter((p) => p.op);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const vals = (f) => op.map(f).filter((x) => x != null);

    // Bank aggregates over operational packs only. Packs are in parallel: currents and
    // power add, voltage is the shared bus (shown as the mean of the packs' readings).
    const P = vals((p) => p.w).length ? sum(vals((p) => p.w)) : null;
    const I = vals((p) => p.i).length ? sum(vals((p) => p.i)) : null;
    const Vs = vals((p) => p.v);
    const V = Vs.length ? sum(Vs) / Vs.length : null;
    const withCap = op.filter((p) => p.cap != null && p.soc != null);
    const capTot = withCap.length ? sum(withCap.map((p) => p.cap)) : null;
    // Capacity-weighted SOC when capacities are known, else a plain mean.
    const soc = withCap.length === op.length && capTot
      ? sum(withCap.map((p) => p.cap * p.soc)) / capTot
      : vals((p) => p.soc).length ? sum(vals((p) => p.soc)) / vals((p) => p.soc).length : null;
    const remTot = op.length && op.every((p) => p.rem != null) ? sum(op.map((p) => p.rem)) : null;
    const charging = P != null && P >= idle, discharging = P != null && P <= -idle;
    let eta = null;
    if (remTot != null && capTot != null && I != null && Math.abs(I) > 0.5) {
      eta = charging ? ((capTot - remTot) / I) * 60 : discharging ? (remTot / -I) * 60 : null;
    }
    const etaTxt = fmtMinutes(eta);

    const stateTxt = !op.length ? "No data" : charging ? "Charging" : discharging ? "Discharging" : "Idle";
    const col = discharging ? "var(--kec-batt-out)" : charging ? "var(--kec-batt-in)" : "var(--kec-muted)";
    const socCol = soc == null ? "var(--kec-muted)" : soc < 15 ? "var(--kec-bad)" : soc < 30 ? "var(--kec-warn)" : "var(--kec-ok)";
    const u = (v, unit) => `${v}<small>${unit}</small>`;
    const t = (label, valueHtml, sub = "") => `<div class="tile"><div class="lbl">${label}</div><div class="val">${valueHtml}</div>${sub ? `<div class="note" style="text-align:left;margin:0">${sub}</div>` : ""}</div>`;
    const socs = vals((p) => p.soc);
    const Vspread = Vs.length > 1 ? Math.max(...Vs) - Math.min(...Vs) : null;

    const top = `<div class="top">
      <div class="socwrap">${ring(soc, { color: socCol })}
        <div class="center"><div class="pct">${soc == null ? "—" : soc.toFixed(soc < 10 ? 1 : 0)}<small>%</small></div>
        <div class="sub">${op.length} of ${present.length} packs</div></div></div>
      <div class="kv">
        ${t("Power", u(P == null ? "—" : (Math.abs(P) / 1000).toFixed(2), "kW"))}
        ${t("Current", u(I == null ? "—" : Math.abs(I).toFixed(1), "A"))}
        ${t("Voltage", u(fmt(V, 2), "V"), Vspread != null && Vspread >= 0.05 ? `±${(Vspread / 2).toFixed(2)} V` : "")}
        ${t(charging ? "Full in" : discharging ? "Empty in" : "Time left", esc(etaTxt ?? "—"))}
        ${t("Stored", remTot == null ? "—" : `${remTot.toFixed(0)}<small>${capTot != null ? `/${capTot.toFixed(0)}` : ""}Ah</small>`)}
        ${t("Pack SOC", socs.length ? u(`${Math.min(...socs).toFixed(0)}–${Math.max(...socs).toFixed(0)}`, "%") : "—", socs.length > 1 ? `${(Math.max(...socs) - Math.min(...socs)).toFixed(0)} pt apart` : "")}
      </div></div>`;

    // Bank-wide cell extremes, naming the pack (and cell) they're in.
    let spread = "";
    const lowP = op.filter((p) => p.cmin != null).sort((a, b) => a.cmin - b.cmin)[0];
    const highP = op.filter((p) => p.cmax != null).sort((a, b) => b.cmax - a.cmax)[0];
    const [lo, hi] = c.cell_range ?? [3.0, 4.2];
    if (lowP && highP) {
      const sp = highP.cmax - lowP.cmin, warn = sp > (c.spread_warn ?? 0.05);
      const x = (v) => clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
      const where = (p, cell) => `pack ${esc(p.name)}${cell != null ? ` · cell ${cell}` : ""}`;
      const worst = op.filter((p) => p.delta != null).sort((a, b) => b.delta - a.delta)[0];
      spread = `<div class="section"><span class="lbl">Cell voltage · all packs</span>
        <div class="spread">
          <div class="val click" data-entity="${esc(lowP.e.cell_min)}">${lowP.cmin.toFixed(3)}<small>V</small></div>
          <div class="rng"><div class="bar"></div><div class="band" style="left:${x(lowP.cmin)}%;width:calc(${x(highP.cmax) - x(lowP.cmin)}% + 4px);--c:${warn ? "var(--kec-warn)" : "var(--kec-ok)"}"></div></div>
          <div class="val click" data-entity="${esc(highP.e.cell_max)}">${highP.cmax.toFixed(3)}<small>V</small></div>
        </div>
        <div class="note"><span class="${warn ? "warn" : ""}">Bank spread ${(sp * 1000).toFixed(0)} mV</span>
          · low ${where(lowP, lowP.cminN)} · high ${where(highP, highP.cmaxN)}
          ${worst ? ` · widest pack ${esc(worst.name)} ${(worst.delta * 1000).toFixed(0)} mV` : ""}</div>
      </div>`;
    }

    // Pack grid.
    const cols = c.columns ?? (packs.length <= 6 ? packs.length : Math.ceil(packs.length / 2));
    const ages = op.map((p) => p.age).filter((a) => a != null);
    const tile = (p) => {
      const [label, st] = STATUS[p.status];
      if (p.status === "absent") return `<div class="pk absent" style="--st:${st}"><div class="row1"><span>#${esc(p.name)}</span></div>
        <div class="soc">—</div><div class="st">Empty slot</div></div>`;
      const ent = p.e.soc || p.e.voltage;
      const dir = p.i == null ? "" : p.i > 0.2 ? "▲" : p.i < -0.2 ? "▼" : "";
      const icol = p.i == null ? "inherit" : p.i > 0.2 ? "var(--kec-batt-in)" : p.i < -0.2 ? "var(--kec-batt-out)" : "var(--kec-muted)";
      const tip = [`Pack ${p.name}`, p.v != null ? `${p.v.toFixed(2)} V` : "", p.delta != null ? `Δ ${(p.delta * 1000).toFixed(0)} mV` : "",
        p.temps.length ? `${Math.max(...p.temps).toFixed(0)} ${p.tunit}` : "", p.cycles != null ? `${p.cycles} cycles` : "",
        p.error ? `Error: ${p.error}` : "", `Last reading ${ago(p.age)} ago`].filter(Boolean).join("\n");
      const stTxt = p.status === "ok" ? (p.balancing ? "Balancing" : `${ago(p.age)} old`)
        : p.status === "stale" ? `${ago(p.age)} old` : p.status === "fault" ? p.error : label;
      return `<div class="pk ${p.op ? "" : "out"}" style="--st:${st}" data-entity="${esc(ent)}" title="${esc(tip)}">
        <div class="row1"><span>#${esc(p.name)}</span><span class="dot"></span></div>
        <div class="soc">${p.soc == null ? "—" : p.soc.toFixed(0)}<small>%</small></div>
        <div class="bar"><i style="width:${clamp(p.soc ?? 0, 0, 100)}%;--c:${p.op ? "var(--kec-home)" : "var(--kec-muted)"}"></i></div>
        <div class="amps" style="color:${icol}">${dir} ${p.i == null ? "—" : Math.abs(p.i).toFixed(1) + " A"}</div>
        <div class="st" style="${p.status === "ok" ? "color:var(--kec-muted)" : ""}">${esc(stTxt)}</div></div>`;
    };
    const used = [...new Set(packs.map((p) => p.status))].filter((s) => s !== "ok" && s !== "absent");
    const grid = `<div class="section"><span class="lbl" style="display:flex;justify-content:space-between">
        <span>Packs</span><span style="text-transform:none;letter-spacing:0">${ages.length ? `readings ${ago(Math.min(...ages))}–${ago(Math.max(...ages))} old` : ""}</span></span>
      <div class="packs" style="--cols:${cols}">${packs.map(tile).join("")}</div>
      ${used.length ? `<div class="legend">${used.map((s) => `<span style="--st:${STATUS[s][1]}"><i></i>${STATUS[s][0]}${s === "fault" ? "" : " · left out"}</span>`).join("")}</div>` : ""}
    </div>`;

    // Lower row.
    const temps = op.flatMap((p) => p.temps.map((v) => ({ v, p })));
    const tmin = temps.length ? temps.reduce((a, b) => (b.v < a.v ? b : a)) : null;
    const tmax = temps.length ? temps.reduce((a, b) => (b.v > a.v ? b : a)) : null;
    const tunit = op.find((p) => p.temps.length)?.tunit ?? "°C";
    const bal = op.filter((p) => p.balancing).length;
    const cyc = vals((p) => p.cycles);
    const lower = [
      tmin ? `<div class="tile" data-entity="${esc(tmax.p.e.temp_1 || tmax.p.e.temp_2)}"><div class="lbl">Temp</div>
        <div class="val">${tmin.v.toFixed(0)}–${tmax.v.toFixed(0)}<small>${esc(tunit)}</small></div><div class="note" style="text-align:left;margin:0">max pack ${esc(tmax.p.name)}</div></div>` : "",
      `<div class="tile"><div class="lbl">Balancing</div><div class="val">${u(bal, bal === 1 ? "pack" : "packs")}</div></div>`,
      cyc.length ? `<div class="tile"><div class="lbl">Cycles</div><div class="val">${Math.min(...cyc)}–${Math.max(...cyc)}</div></div>` : "",
    ].join("");

    const faults = packs.filter((p) => p.status === "fault");
    const alarm = faults.length ? `<div class="alarm">${faults.map((p) => `Pack ${esc(p.name)}: ${esc(p.error)}`).join("<br>")}</div>` : "";

    return `<ha-card>
      <div class="head"><ha-icon icon="${esc(c.icon ?? "mdi:battery-high")}"></ha-icon><div class="title">${esc(c.name ?? "Saft bank")}</div>
        ${etaTxt && (charging || discharging) ? `<span class="muted" style="font-size:.8rem">${charging ? "Full" : "Empty"} in ${esc(etaTxt)}</span>` : ""}
        ${faults.length ? `<span class="chip" style="--chip:var(--kec-bad)">Fault</span>` : ""}
        <span class="chip" style="--chip:${col}">${stateTxt}</span></div>
      ${top}${alarm}${spread}${grid}
      ${lower ? `<div class="section tiles">${lower}</div>` : ""}
    </ha-card>`;
  }
}

/* ----------------------------------------------------------- editor & picker */

class SaftEditor extends KecEditor {
  static fields = [
    F("name", ["name"], S_TEXT, "Name"),
    F("icon", ["icon"], S_ICON, "Icon"),
    F("count", ["count"], S_NUM(1, 64), "Number of packs", undefined, "Packs without sensors show as “not installed”"),
    F("match", ["match"], S_TEXT, "Sensor id pattern", undefined, "Part of the entity id before each value; {n} is the pack number, e.g. saft_{n}_"),
    F("capacity_ah", ["capacity_ah"], S_NUM(0, 2000, 1, "Ah"), "Capacity per pack", undefined, "For weighted SOC, stored Ah and time to full/empty, when the BMS doesn't report it"),
    F("stale_after", ["stale_after"], S_NUM(1, 240, 1, "min"), "Leave a pack out after no reading for"),
    { key: "cell_lo", selector: S_NUM(0, 5, 0.05, "V"), label: "Cell range low", group: "Advanced",
      get: (c) => c.cell_range?.[0], set: (c, v) => ({ ...c, cell_range: [v ?? 3.0, c.cell_range?.[1] ?? 4.2] }) },
    { key: "cell_hi", selector: S_NUM(0, 5, 0.05, "V"), label: "Cell range high", group: "Advanced",
      get: (c) => c.cell_range?.[1], set: (c, v) => ({ ...c, cell_range: [c.cell_range?.[0] ?? 3.0, v ?? 4.2] }) },
    F("spread_warn", ["spread_warn"], S_NUM(0, 1, 0.005, "V"), "Warn when bank cell spread exceeds", "Advanced"),
    F("columns", ["columns"], S_NUM(1, 12), "Pack grid columns", "Advanced"),
    F("idle_threshold", ["idle_threshold"], S_NUM(0, 1000, 5, "W"), "Idle below", "Advanced"),
  ];
}

function stubSaft(hass) {
  const ns = Object.keys(hass?.states || {}).map((id) => id.match(/(?:^|[._])saft_(\d+)_(?:soc|total_voltage)(?:_\d+)?$/)?.[1]).filter(Boolean).map(Number);
  return { name: "Saft bank", match: "saft_{n}_", count: ns.length ? Math.max(12, ...ns) : 12, stale_after: 10 };
}

SaftPacksCard.getConfigElement = () => document.createElement("saft-packs-card-editor");
SaftPacksCard.getStubConfig = (hass) => stubSaft(hass);
if (!customElements.get("saft-packs-card-editor")) customElements.define("saft-packs-card-editor", SaftEditor);
if (!customElements.get("saft-packs-card")) customElements.define("saft-packs-card", SaftPacksCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((x) => x.type === "saft-packs-card"))
  window.customCards.push({
    type: "saft-packs-card", name: "Saft packs overview (krogo)", preview: true,
    description: "Many parallel packs, each with its own BMS: bank totals from the packs that are reporting, plus a tile per pack",
    documentationURL: "https://github.com/krogo/Saft_packs_overview_card",
    // HA 2026.6+: offer the card when a Saft pack sensor is picked.
    getEntitySuggestion: (hass, entityId) => (/(^|[._])saft_\d+_/.test(entityId) ? { config: { type: "custom:saft-packs-card", ...stubSaft(hass) } } : null),
  });
console.info(`%c saft-packs-card %c ${VERSION} `, "background:#4db6ac;color:#000;font-weight:600", "background:#333;color:#fff");
