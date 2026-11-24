import json, random, datetime as dt
random.seed(4)
now = dt.datetime.now(dt.timezone.utc)
def iso(mins): return (now - dt.timedelta(minutes=mins)).isoformat()
def build(mixed):
    S = {}
    def put(eid, state, unit=None, age=1.0):
        a = {"friendly_name": eid}
        if unit: a["unit_of_measurement"] = unit
        S[eid] = {"entity_id": eid, "state": str(state), "attributes": a, "last_updated": iso(age), "last_changed": iso(age)}
    for n in range(1, 9):
        dev = "saft_bank_a" if n <= 6 else "saft_bank_b"
        p = f"{dev}_saft_{n}_"
        age = [0.4, 0.8, 1.2, 1.7, 2.1, 2.5, 0.6, 1.1][n-1]
        soc = [72, 74, 71, 73, 70, 75, 69, 72][n-1]
        cur = [-8.1, -7.9, -8.4, -7.6, -8.8, -7.4, -8.0, -8.2][n-1]
        on, chg, dis, err, bal = "on", "on", "on", "", "off"
        if n == 3: bal = "on"
        if mixed:
            if n == 4: age = 26
            if n == 5: err = "Cell overvoltage"
            if n == 6: chg = dis = "off"; cur = 0.0
            if n == 8: on = "off"
        v = 51.6 + soc * 0.002 + random.uniform(-.02, .02)
        cmin = 3.68 + random.uniform(0, .01); cmax = cmin + random.uniform(.004, .022)
        if mixed and n == 5: cmax = 4.21
        put(f"sensor.{p}total_voltage", f"{v:.2f}", "V", age)
        put(f"sensor.{p}current", f"{cur:.2f}", "A", age)
        put(f"sensor.{p}power", f"{v*cur:.1f}", "W", age)
        put(f"sensor.{p}soc", soc, "%", age)
        put(f"sensor.{p}avg_cell_v", f"{(cmin+cmax)/2:.3f}", "V", age)
        put(f"sensor.{p}delta_cell_v", f"{cmax-cmin:.3f}", "V", age)
        put(f"sensor.{p}min_cell_v", f"{cmin:.3f}", "V", age)
        put(f"sensor.{p}max_cell_v", f"{cmax:.3f}", "V", age)
        put(f"sensor.{p}min_cell", random.randint(1, 14), None, age)
        put(f"sensor.{p}max_cell", random.randint(1, 14), None, age)
        put(f"sensor.{p}temp_1", f"{19+random.uniform(0,3):.1f}", "°C", age)
        put(f"sensor.{p}temp_2", f"{19+random.uniform(0,4):.1f}", "°C", age)
        put(f"binary_sensor.{p}online", on, None, age)
        put(f"binary_sensor.{p}charging", chg, None, age)
        put(f"binary_sensor.{p}discharging", dis, None, age)
        put(f"binary_sensor.{p}balancing", bal, None, age)
        put(f"sensor.{p}errors", err, None, age)
    return S
json.dump(build(False), open("states.json", "w"), indent=1)
json.dump(build(True), open("states_mixed.json", "w"), indent=1)
json.dump([{"type": "custom:saft-packs-card", "name": "Saft bank", "count": 12, "match": "saft_{n}_", "capacity_ah": 50}], open("cards.json", "w"))
