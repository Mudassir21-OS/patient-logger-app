/* Patient Logger (iPhone web app) - all data stays on the phone.
   Every record is kept in two places on the phone (IndexedDB + a safety copy) and is never
   removed unless the user empties "Recently deleted" on purpose. */
(function () {
  "use strict";

  var P = window.PatientParser;
  var $ = function (id) { return document.getElementById(id); };
  var DAY_HEADERS = ["No.", "Time", "Patient Name", "Patient ID", "Age", "Gender", "Diagnosis"];
  var ALL_HEADERS = ["No.", "Date", "Time", "Patient Name", "Patient ID", "Age", "Gender", "Diagnosis"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December"];
  var MIRROR_KEY = "pl-mirror-v1";
  var BACKUP_EVERY_DAYS = 7, BACKUP_EVERY_RECORDS = 100;

  // ------------------------------------------------------------------ settings
  var DEFAULTS = { idDigitsOnly: true, idMin: 4, idMax: 12, lastExport: 0, lastBackup: 0, monthsExported: {} };
  var settings = loadSettings();
  function loadSettings() {
    var s = Object.assign({}, DEFAULTS);
    try { Object.assign(s, JSON.parse(localStorage.getItem("pl-settings") || "{}")); } catch (e) { /* ignore */ }
    if (!s.monthsExported || typeof s.monthsExported !== "object") s.monthsExported = {};
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem("pl-settings", JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ storage (IndexedDB + safety copy)
  var db = null;
  var records = []; // every record, including ones in "Recently deleted" (deletedAt set), oldest first
  var mirrorOk = true;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("patient-logger", 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains("records")) {
          var st = d.createObjectStore("records", { keyPath: "uid" });
          st.createIndex("date", "date");
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error("Database blocked - close other Patient Logger windows.")); };
    });
  }
  function tx(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!db) { reject(new Error("no database")); return; }
      var t = db.transaction("records", mode);
      var st = t.objectStore("records");
      var out = fn(st);
      t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error("Save aborted (storage full?)")); };
    });
  }
  function dbAll() { return tx("readonly", function (st) { return st.getAll(); }); }
  function dbPutMany(list) { return tx("readwrite", function (st) { list.forEach(function (r) { st.put(r); }); }); }
  function dbDeleteMany(uids) { return tx("readwrite", function (st) { uids.forEach(function (u) { st.delete(u); }); }); }

  function readMirror() {
    try {
      var m = JSON.parse(localStorage.getItem(MIRROR_KEY) || "null");
      return m && Array.isArray(m.records) ? m.records : [];
    } catch (e) { return []; }
  }
  function writeMirror() {
    try {
      localStorage.setItem(MIRROR_KEY, JSON.stringify({ v: 1, saved: Date.now(), records: records }));
      mirrorOk = true;
      return true;
    } catch (e) { mirrorOk = false; return false; }
  }

  /* Save changed records. Succeeds if at least one of the two stores took it. */
  function persist(changed) {
    var mirrorSaved = writeMirror();
    return dbPutMany(changed).then(function () { return true; }, function (e) {
      if (mirrorSaved) return true;
      throw e;
    });
  }

  function normaliseRecord(r) {
    if (!r || typeof r.uid !== "string" || typeof r.name !== "string" || typeof r.ts !== "number" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.date || "") || typeof r.time !== "string") return null;
    var diag = r.diagnosis !== undefined ? r.diagnosis : r.notes; // older versions called it "notes"
    var out = { uid: r.uid, ts: r.ts, date: r.date, time: r.time, name: String(r.name), pid: String(r.pid || ""),
      age: String(r.age || ""), gender: String(r.gender || ""), diagnosis: String(diag || ""),
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : r.ts };
    if (typeof r.deletedAt === "number") out.deletedAt = r.deletedAt;
    return out;
  }

  /* Combine two lists by uid; the most recently changed version wins. Returns merged list. */
  function mergeLists(a, b) {
    var map = {};
    a.concat(b).forEach(function (r) {
      r = normaliseRecord(r);
      if (!r) return;
      var cur = map[r.uid];
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) map[r.uid] = r;
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (x, y) { return x.ts - y.ts; });
  }

  // ------------------------------------------------------------------ helpers
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function timeKey(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); }
  function today() { return dayKey(new Date()); }
  function monthOf(day) { return day.slice(0, 7); }
  function monthLabel(ym) { var p = ym.split("-"); return MONTHS[+p[1] - 1] + " " + p[0]; }
  function prettyDay(key) {
    if (key === today()) return "Today";
    var y = new Date(); y.setDate(y.getDate() - 1);
    if (key === dayKey(y)) return "Yesterday";
    var p = key.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  function sheetDay(key) { var p = key.split("-"); return p[2] + " " + MONTHS[+p[1] - 1].slice(0, 3) + " " + p[0]; }
  function uid() { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
  function live() { return records.filter(function (r) { return !r.deletedAt; }); }
  function bin() { return records.filter(function (r) { return r.deletedAt; }); }
  function todays() { var t = today(); return live().filter(function (r) { return r.date === t; }); }
  function days() {
    var seen = {}, out = [];
    live().forEach(function (r) { if (!seen[r.date]) { seen[r.date] = 1; out.push(r.date); } });
    return out.sort().reverse();
  }
  function months() {
    var seen = {}, out = [];
    live().forEach(function (r) { var m = monthOf(r.date); if (!seen[m]) { seen[m] = 1; out.push(m); } });
    return out.sort().reverse();
  }
  function normName(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  function normId(s) {
    s = String(s || "").replace(/[\s-]/g, "");
    return settings.idDigitsOnly ? s : s.toUpperCase();
  }
  function normAge(s) { return String(s || "").toLowerCase().replace(/\s+/g, "").replace(/months?$/, "m"); }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast hidden"; }, 2800);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function isStandalone() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  // ------------------------------------------------------------------ tabs
  function showTab(id) {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) { t.classList.toggle("active", t.id === id); });
    Array.prototype.forEach.call(document.querySelectorAll(".tabbar button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === id);
    });
    if (id === "tab-records") renderRecords();
    if (id === "tab-more") renderMore();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ gender segmented control
  function segValue(segId) {
    var on = document.querySelector("#" + segId + " button.on");
    return on ? on.getAttribute("data-g") : "";
  }
  function setSeg(segId, value) {
    Array.prototype.forEach.call(document.querySelectorAll("#" + segId + " button"), function (b) {
      var on = b.getAttribute("data-g") === value;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  function wireSeg(segId, onChange) {
    Array.prototype.forEach.call(document.querySelectorAll("#" + segId + " button"), function (b) {
      b.addEventListener("click", function () {
        var v = b.getAttribute("data-g");
        setSeg(segId, segValue(segId) === v ? "" : v); // tap again to clear
        if (onChange) onChange();
      });
    });
  }

  // ------------------------------------------------------------------ new-patient form
  var form = {
    get: function () {
      return { name: normName($("f-name").value), pid: normId($("f-id").value), age: normAge($("f-age").value),
        gender: segValue("f-gender"), diagnosis: $("f-diag").value.trim() };
    },
    clear: function () {
      $("f-name").value = ""; $("f-id").value = ""; $("f-age").value = ""; $("f-diag").value = "";
      setSeg("f-gender", ""); $("speak").value = ""; lastParsedText = ""; checkForm();
    }
  };

  function findTodayId(pid, exceptUid) {
    var t = today();
    for (var i = records.length - 1; i >= 0; i--) {
      var r = records[i];
      if (!r.deletedAt && r.date === t && r.pid === pid && r.uid !== exceptUid) return r;
    }
    return null;
  }

  function problems(v, exceptUid) {
    var errs = [];
    var idErr = v.pid ? P.validateId(v.pid, settings) : null;
    if (idErr) errs.push(idErr);
    var ageErr = P.validateAge(v.age);
    if (ageErr) errs.push(ageErr);
    var info = "";
    if (!idErr && v.pid) {
      var dup = findTodayId(v.pid, exceptUid);
      if (dup) info = "Note: ID " + v.pid + " was already entered today at " + dup.time.slice(0, 5) + " (" + dup.name + ").";
    }
    return { errs: errs, info: info };
  }

  function checkForm() {
    var pr = problems(form.get());
    var w = $("warn");
    w.textContent = pr.errs.length ? pr.errs.join(" ") : pr.info;
    w.className = "warn-text" + (!pr.errs.length && pr.info ? " info" : "");
  }

  var saving = false, lastSaveAt = 0;
  function savePatient() {
    if (saving) return;
    var v = form.get();
    if (!v.name) { toast("Patient name is empty", "err"); $("f-name").focus(); return; }
    var idErr = P.validateId(v.pid, settings);
    if (idErr) { toast(idErr, "err"); $("f-id").focus(); return; }
    var ageErr = P.validateAge(v.age);
    if (ageErr) { toast(ageErr, "err"); $("f-age").focus(); return; }
    var dup = findTodayId(v.pid);
    if (dup && !window.confirm("ID " + v.pid + " was already entered today at " + dup.time.slice(0, 5) +
      " as “" + dup.name + "”.\n\nSave it again?")) return;

    var now = new Date();
    var rec = { uid: uid(), ts: now.getTime(), updatedAt: now.getTime(), date: dayKey(now), time: timeKey(now),
      name: v.name, pid: v.pid, age: v.age, gender: v.gender, diagnosis: v.diagnosis };
    saving = true;
    records.push(rec);
    persist([rec]).then(function () {
      lastSaveAt = Date.now();
      form.clear();
      refreshSummary();
      toast("Saved: " + rec.name + " (" + rec.pid + ")", "ok");
      if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) { /* ignore */ } }
    }).catch(function (e) {
      // nothing could be stored: take it back out and keep the form filled so nothing is lost
      records = records.filter(function (r) { return r.uid !== rec.uid; });
      toast("Could not save – the details are still in the form. " + (e && e.message ? e.message : ""), "err");
    }).then(function () { saving = false; });
  }

  /* Deleting only moves a record to "Recently deleted" - it can always be restored. */
  function deleteRecord(rec, ask) {
    if (ask && !window.confirm("Delete this entry?\n\n" + rec.name + " – ID " + rec.pid + " (" + rec.time.slice(0, 5) +
      ")\n\nIt goes to Recently deleted, where you can restore it.")) {
      return Promise.resolve(false);
    }
    var upd = Object.assign({}, rec, { deletedAt: Date.now(), updatedAt: Date.now() });
    return replace([upd]).then(function () {
      toast("Moved to Recently deleted: " + rec.name);
      return true;
    }).catch(function (e) { toast("Could not delete: " + e, "err"); return false; });
  }
  function replace(updated) {
    var byId = {};
    updated.forEach(function (u) { byId[u.uid] = u; });
    var before = records;
    records = records.map(function (r) { return byId[r.uid] || r; });
    return persist(updated).then(function () { refreshSummary(); }, function (e) { records = before; throw e; });
  }
  function deleteLast() {
    var t = todays();
    if (!t.length) { toast("Nothing saved today"); return; }
    deleteRecord(t[t.length - 1], true);
  }

  // ------------------------------------------------------------------ speak box
  var lastParsedText = "";
  var parseTimer = null, commandTimer = null;

  function applyParse(final) {
    var text = $("speak").value;
    if (!text.trim()) return;
    var p = P.parseUtterance(text, settings.idDigitsOnly, settings.idMin);
    if (p.command) {
      if (!final) { scheduleCommand(); return; }
      $("speak").value = ""; lastParsedText = "";
      if (p.command === "save") savePatient();
      else if (p.command === "clear") { form.clear(); toast("Cleared – ready for the next patient"); }
      else if (p.command === "delete_last") deleteLast();
      return;
    }
    if (text !== lastParsedText) {
      lastParsedText = text;
      if (p.name) $("f-name").value = p.name;
      if (p.id) $("f-id").value = p.id;
      if (p.age) $("f-age").value = p.age;
      if (p.gender) setSeg("f-gender", p.gender);
      if (p.diagnosis) $("f-diag").value = p.diagnosis;
      checkForm();
    }
    if (p.save_after) {
      if (final) savePatient();
      else scheduleCommand();
    }
  }
  function scheduleCommand() {
    clearTimeout(commandTimer);
    // dictation has gone quiet for a moment -> treat "save"/"next patient" as final
    commandTimer = setTimeout(function () { applyParse(true); }, 1400);
  }

  // ------------------------------------------------------------------ records tab
  function renderRecords() {
    var sel = $("date-filter");
    var current = sel.value || "today";
    sel.innerHTML = "";
    var opts = [["today", "Today"], ["all", "All days"]];
    months().forEach(function (m) { opts.push(["m:" + m, monthLabel(m)]); });
    days().forEach(function (d) { if (d !== today()) opts.push([d, prettyDay(d)]); });
    opts.forEach(function (o) { var op = el("option", "", o[1]); op.value = o[0]; sel.appendChild(op); });
    sel.value = opts.some(function (o) { return o[0] === current; }) ? current : "today";

    var q = $("search").value.trim().toLowerCase();
    var qd = q.replace(/\D/g, "");
    var f = sel.value;
    var list = live().filter(function (r) {
      if (q) return r.name.toLowerCase().indexOf(q) >= 0 || r.pid.toLowerCase().indexOf(q) >= 0 || (qd && r.pid === qd);
      if (f === "today") return r.date === today();
      if (f === "all") return true;
      if (f.indexOf("m:") === 0) return monthOf(r.date) === f.slice(2);
      return r.date === f;
    }).reverse();

    var ul = $("records");
    ul.innerHTML = "";
    $("records-count").textContent = (q ? "Search results (all days): " : "") + plural(list.length, "record");
    if (!list.length) {
      ul.appendChild(el("li", "empty", q ? "No matches." : "No records here yet."));
      return;
    }
    var lastDay = null;
    var showDays = q || f === "all" || f.indexOf("m:") === 0;
    var shown = 0;
    list.forEach(function (r) {
      if (shown >= 500) return; // keep the list fast; search narrows it down
      shown++;
      if (showDays && r.date !== lastDay) { ul.appendChild(el("li", "day", prettyDay(r.date))); lastDay = r.date; }
      var li = el("li");
      li.appendChild(el("div", "nm", r.name));
      li.appendChild(el("div", "tm", r.time.slice(0, 5)));
      var meta = ["ID " + r.pid];
      if (r.age) meta.push(/m$/.test(r.age) ? r.age.replace("m", " months") : r.age + " yrs");
      if (r.gender) meta.push(r.gender);
      li.appendChild(el("div", "meta", meta.join(" · ")));
      if (r.diagnosis) li.appendChild(el("div", "nt", r.diagnosis));
      li.addEventListener("click", function () { openSheet(r); });
      ul.appendChild(li);
    });
    if (list.length > shown) ul.appendChild(el("li", "empty", "Showing the latest 500 – search to find older ones."));
  }

  // ------------------------------------------------------------------ edit sheet
  var editing = null;
  function openSheet(r) {
    editing = r;
    $("e-when").textContent = prettyDay(r.date) + " at " + r.time.slice(0, 5);
    $("e-name").value = r.name; $("e-id").value = r.pid; $("e-age").value = r.age || "";
    setSeg("e-gender", r.gender || ""); $("e-diag").value = r.diagnosis || ""; $("e-warn").textContent = "";
    $("sheet").classList.remove("hidden");
  }
  function closeSheet() { $("sheet").classList.add("hidden"); editing = null; }
  function saveEdit() {
    if (!editing) return;
    var v = { name: normName($("e-name").value), pid: normId($("e-id").value), age: normAge($("e-age").value),
      gender: segValue("e-gender"), diagnosis: $("e-diag").value.trim() };
    var errs = [];
    if (!v.name) errs.push("Patient name is empty.");
    var idErr = P.validateId(v.pid, settings); if (idErr) errs.push(idErr);
    var ageErr = P.validateAge(v.age); if (ageErr) errs.push(ageErr);
    if (errs.length) { $("e-warn").textContent = errs.join(" "); return; }
    var updated = Object.assign({}, editing, v, { updatedAt: Date.now() });
    replace([updated]).then(function () {
      closeSheet(); renderRecords(); toast("Changes saved", "ok");
    }).catch(function (e) { $("e-warn").textContent = "Could not save: " + e; });
  }

  // ------------------------------------------------------------------ Excel export
  function fileStamp() { var d = new Date(); return dayKey(d) + "_" + pad(d.getHours()) + pad(d.getMinutes()); }

  function deliverFile(blob, filename, mime) {
    var file;
    try { file = new File([blob], filename, { type: mime }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: filename }).then(function () { return true; })
        .catch(function (e) {
          if (e && e.name === "AbortError") return false; // user closed the share sheet
          return downloadBlob(blob, filename);
        });
    }
    return Promise.resolve(downloadBlob(blob, filename));
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return true;
  }

  function ageCell(a) { return /^\d+$/.test(a || "") ? +a : (a || ""); }
  function byTime(list) { return list.slice().sort(function (a, b) { return a.ts - b.ts; }); }
  function groupBy(list, keyFn) {
    var g = {};
    list.forEach(function (r) { var k = keyFn(r); (g[k] = g[k] || []).push(r); });
    return g;
  }
  function daySheet(list) {
    var rows = [DAY_HEADERS];
    byTime(list).forEach(function (r, i) {
      rows.push([i + 1, r.time, r.name, String(r.pid), ageCell(r.age), r.gender || "", r.diagnosis || ""]);
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 5 }, { wch: 9 }, { wch: 30 }, { wch: 14 }, { wch: 6 }, { wch: 8 }, { wch: 45 }];
    return ws;
  }
  function allSheet(list) {
    var rows = [ALL_HEADERS];
    byTime(list).forEach(function (r, i) {
      rows.push([i + 1, r.date, r.time, r.name, String(r.pid), ageCell(r.age), r.gender || "", r.diagnosis || ""]);
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 6 }, { wch: 11 }, { wch: 9 }, { wch: 30 }, { wch: 14 }, { wch: 6 }, { wch: 8 }, { wch: 45 }];
    return ws;
  }
  function summarySheet(groups, keys, label) {
    var rows = [[label, "Patients", "Male", "Female", "Other", "Not given"]];
    var tot = [0, 0, 0, 0, 0];
    keys.forEach(function (k) {
      var l = groups[k], c = [l.length, 0, 0, 0, 0];
      l.forEach(function (r) {
        if (r.gender === "Male") c[1]++; else if (r.gender === "Female") c[2]++;
        else if (r.gender === "Other") c[3]++; else c[4]++;
      });
      c.forEach(function (v, i) { tot[i] += v; });
      rows.push([k].concat(c));
    });
    rows.push(["Total"].concat(tot));
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }];
    return ws;
  }

  function buildDayBook(list) {
    var wb = XLSX.utils.book_new();
    var g = groupBy(list, function (r) { return r.date; });
    Object.keys(g).sort().forEach(function (d) { XLSX.utils.book_append_sheet(wb, daySheet(g[d]), sheetDay(d)); });
    return wb;
  }
  function buildMonthBook(list) {
    var wb = XLSX.utils.book_new();
    var g = groupBy(list, function (r) { return r.date; });
    var keys = Object.keys(g).sort();
    XLSX.utils.book_append_sheet(wb, summarySheet(g, keys, "Date"), "Summary");
    XLSX.utils.book_append_sheet(wb, allSheet(list), "All patients");
    keys.forEach(function (d) { XLSX.utils.book_append_sheet(wb, daySheet(g[d]), sheetDay(d)); });
    return wb;
  }
  function buildAllBook(list) {
    var wb = XLSX.utils.book_new();
    var g = groupBy(list, function (r) { return monthOf(r.date); });
    var keys = Object.keys(g).sort();
    XLSX.utils.book_append_sheet(wb, summarySheet(g, keys, "Month"), "Summary");
    XLSX.utils.book_append_sheet(wb, allSheet(list), "All patients");
    keys.forEach(function (m) { XLSX.utils.book_append_sheet(wb, allSheet(g[m]), monthLabel(m)); });
    return wb;
  }

  function exportBook(wb, filename, onDone) {
    var out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    var mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return deliverFile(new Blob([out], { type: mime }), filename, mime).then(function (done) {
      if (done) {
        settings.lastExport = Date.now();
        if (onDone) onDone();
        saveSettings(); renderMore(); refreshSummary();
      }
      return done;
    });
  }
  function ready(list) {
    if (!list.length) { toast("No records to export", "err"); return false; }
    if (!window.XLSX) { toast("Excel module still loading – try again in a second", "err"); return false; }
    return true;
  }
  function exportDay(d) {
    var list = live().filter(function (r) { return r.date === d; });
    if (ready(list)) exportBook(buildDayBook(list), "Patients_" + d + ".xlsx");
  }
  function exportMonth(ym) {
    var list = live().filter(function (r) { return monthOf(r.date) === ym; });
    if (!ready(list)) return;
    exportBook(buildMonthBook(list), "Patients_" + ym + "_" + MONTHS[+ym.slice(5) - 1] + ".xlsx", function () {
      settings.monthsExported[ym] = Date.now();
    });
  }
  function exportAll() {
    var list = live();
    if (!ready(list)) return;
    exportBook(buildAllBook(list), "Patients_all_until_" + today() + ".xlsx");
  }

  // ------------------------------------------------------------------ backup / restore
  function backup() {
    if (!records.length) { toast("No records to back up", "err"); return; }
    var data = JSON.stringify({ app: "patient-logger", version: 2, exported: new Date().toISOString(), records: records }, null, 1);
    deliverFile(new Blob([data], { type: "application/json" }), "patient-logger-backup_" + fileStamp() + ".json", "application/json")
      .then(function (done) {
        if (done) { settings.lastBackup = Date.now(); saveSettings(); renderMore(); refreshSummary(); toast("Backup saved", "ok"); }
      });
  }

  function restore(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (e) { toast("That file is not a Patient Logger backup", "err"); return; }
      var list = data && Array.isArray(data.records) ? data.records : null;
      if (!list || data.app !== "patient-logger") { toast("That file is not a Patient Logger backup", "err"); return; }
      var have = {}; records.forEach(function (r) { have[r.uid] = 1; });
      var fresh = list.map(normaliseRecord).filter(function (r) { return r && !have[r.uid]; });
      if (!fresh.length) { toast("Nothing new in that backup – all its records are already here"); return; }
      if (!window.confirm("Add " + plural(fresh.length, "record") + " from this backup?")) return;
      var before = records;
      records = mergeLists(records, fresh);
      persist(fresh).then(function () {
        refreshSummary(); renderMore();
        toast("Restored " + plural(fresh.length, "record"), "ok");
      }).catch(function (e) { records = before; toast("Restore failed: " + e, "err"); });
    };
    reader.onerror = function () { toast("Could not read that file", "err"); };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------------ recently deleted
  function restoreFromBin(list) {
    var upd = list.map(function (r) { var u = Object.assign({}, r, { updatedAt: Date.now() }); delete u.deletedAt; return u; });
    return replace(upd).then(function () {
      renderMore(); toast("Restored " + plural(upd.length, "record"), "ok");
    }).catch(function (e) { toast("Could not restore: " + e, "err"); });
  }
  function moveAllToBin() {
    var l = live();
    if (!l.length) { toast("There are no records"); return; }
    if (!window.confirm("Move ALL " + plural(l.length, "record") + " to Recently deleted?\n\nYou can still restore them from there.")) return;
    var now = Date.now();
    replace(l.map(function (r) { return Object.assign({}, r, { deletedAt: now, updatedAt: now }); })).then(function () {
      renderMore(); toast("All records moved to Recently deleted");
    }).catch(function (e) { toast("Could not delete: " + e, "err"); });
  }
  function emptyBin() {
    var b = bin();
    if (!b.length) { toast("Recently deleted is empty"); return; }
    if (!window.confirm("Permanently erase " + plural(b.length, "record") + " from this phone?\n\nThis is the only step that cannot be undone. Make sure you have exported or backed them up.")) return;
    var typed = window.prompt("Type ERASE to confirm");
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== "ERASE") { toast("Nothing was erased"); return; }
    var ids = b.map(function (r) { return r.uid; });
    var gone = {}; ids.forEach(function (u) { gone[u] = 1; });
    var before = records;
    records = records.filter(function (r) { return !gone[r.uid]; });
    var mirrorSaved = writeMirror();
    dbDeleteMany(ids).catch(function () { if (!mirrorSaved) throw new Error("storage error"); }).then(function () {
      renderMore(); refreshSummary(); toast("Erased " + plural(ids.length, "record"));
    }).catch(function (e) { records = before; writeMirror(); toast("Could not erase: " + e, "err"); });
  }
  function renderBin() {
    var b = bin().sort(function (x, y) { return y.deletedAt - x.deletedAt; });
    $("bin-count").textContent = b.length ? plural(b.length, "record") + " – tap Restore to put one back." : "Nothing here.";
    var ul = $("bin-list");
    ul.innerHTML = "";
    b.slice(0, 200).forEach(function (r) {
      var li = el("li");
      li.appendChild(el("div", "nm", r.name));
      var btn = el("button", "link", "Restore");
      btn.type = "button";
      btn.addEventListener("click", function (e) { e.stopPropagation(); restoreFromBin([r]); });
      li.appendChild(btn);
      li.appendChild(el("div", "meta", "ID " + r.pid + " · " + prettyDay(r.date) + " " + r.time.slice(0, 5)));
      ul.appendChild(li);
    });
    $("btn-bin-restore-all").classList.toggle("hidden", b.length < 2);
    $("btn-bin-empty").classList.toggle("hidden", !b.length);
  }

  // ------------------------------------------------------------------ "More" tab
  function fillSelect(sel, items, emptyText) {
    var cur = sel.value;
    sel.innerHTML = "";
    if (!items.length) { var o = el("option", "", emptyText); o.value = ""; sel.appendChild(o); return; }
    items.forEach(function (it) { var op = el("option", "", it[1]); op.value = it[0]; sel.appendChild(op); });
    if (cur && items.some(function (it) { return it[0] === cur; })) sel.value = cur;
  }
  function renderMore() {
    var L = live();
    var ds = days(), ms = months();
    fillSelect($("export-month"), ms.map(function (m) {
      var n = L.filter(function (r) { return monthOf(r.date) === m; }).length;
      var p = m.split("-");
      return [m, MONTHS[+p[1] - 1].slice(0, 3) + " " + p[0] + " · " + n + (settings.monthsExported[m] ? " ✓" : "")];
    }), "No records yet");
    fillSelect($("export-day"), ds.map(function (d) {
      var n = L.filter(function (r) { return r.date === d; }).length;
      return [d, prettyDay(d) + " (" + n + ")"];
    }), "No records yet");
    var parts = [];
    parts.push(settings.lastExport ? "Last Excel export: " + new Date(settings.lastExport).toLocaleString() : "No Excel export yet.");
    parts.push(settings.lastBackup ? "Last backup file: " + new Date(settings.lastBackup).toLocaleString() : "No backup file yet.");
    $("last-export").textContent = parts.join(" ");
    $("s-digits").checked = !!settings.idDigitsOnly;
    $("s-min").value = settings.idMin; $("s-max").value = settings.idMax;
    var info = plural(L.length, "record") + " over " + plural(ds.length, "day") + ", stored twice on this phone" +
      (mirrorOk ? "" : " (safety copy full – please save a backup file)") + ".";
    $("storage-info").textContent = info + (persisted ? " Protected from automatic clean-up." : "");
    renderBin();
  }

  // ------------------------------------------------------------------ summary + banners
  function notBackedUp() {
    var since = settings.lastBackup || 0;
    return live().filter(function (r) { return r.ts > since; }).length;
  }
  function refreshSummary() {
    var t = todays();
    $("today-count").textContent = "Today: " + t.length;
    if (t.length) {
      var l = t[t.length - 1];
      $("last-entry").textContent = "Last: " + l.name + " (" + l.pid + ") at " + l.time.slice(0, 5);
      $("btn-undo").classList.remove("hidden");
    } else {
      $("last-entry").textContent = "No patients saved today yet.";
      $("btn-undo").classList.add("hidden");
    }

    // backup reminder
    var b = $("banner-backup");
    var n = notBackedUp();
    var L = live();
    var oldestUnsaved = L.filter(function (r) { return r.ts > (settings.lastBackup || 0); })[0];
    var days7 = BACKUP_EVERY_DAYS * 24 * 3600 * 1000;
    if (n >= BACKUP_EVERY_RECORDS || (oldestUnsaved && Date.now() - oldestUnsaved.ts > days7)) {
      b.textContent = plural(n, "record") + (n === 1 ? " is" : " are") + " only on this phone and not in a backup yet. " +
        "Go to Export & more → Save backup file (takes 10 seconds).";
      b.classList.remove("hidden");
    } else b.classList.add("hidden");

    // month finished -> offer the month workbook
    var mb = $("banner-month");
    var cur = monthOf(today());
    var pending = months().filter(function (m) { return m < cur && !settings.monthsExported[m]; });
    if (pending.length) {
      var m = pending[0];
      $("banner-month-text").textContent = monthLabel(m) + " is finished. Export its Excel workbook (" +
        plural(L.filter(function (r) { return monthOf(r.date) === m; }).length, "patient") + ").";
      $("btn-banner-month").setAttribute("data-month", m);
      mb.classList.remove("hidden");
    } else mb.classList.add("hidden");
    checkForm();
  }

  // ------------------------------------------------------------------ wiring
  var persisted = false;
  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll(".tabbar button"), function (b) {
      b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); });
    });
    wireSeg("f-gender", checkForm);
    wireSeg("e-gender");

    var speak = $("speak");
    speak.addEventListener("input", function () {
      clearTimeout(parseTimer);
      parseTimer = setTimeout(function () { applyParse(false); }, 350);
    });
    speak.addEventListener("blur", function () {
      clearTimeout(parseTimer); clearTimeout(commandTimer);
      applyParse(true);
    });

    ["f-name", "f-id", "f-age", "f-diag"].forEach(function (id) { $(id).addEventListener("input", checkForm); });
    $("btn-save").addEventListener("click", function () {
      clearTimeout(parseTimer); clearTimeout(commandTimer);
      var v0 = form.get();
      // the Speak box's "...and save" may already have saved this patient when the box lost focus
      if (saving || (Date.now() - lastSaveAt < 2000 && !v0.name && !v0.pid && !$("speak").value.trim())) return;
      var text = $("speak").value;
      if (text.trim()) { // make sure the latest dictation is applied before saving
        var p = P.parseUtterance(text, settings.idDigitsOnly, settings.idMin);
        if (!p.command && text !== lastParsedText) applyParse(false);
      }
      savePatient();
    });
    $("btn-clear").addEventListener("click", function () { form.clear(); });
    $("speak-clear").addEventListener("click", function () { $("speak").value = ""; lastParsedText = ""; $("speak").focus(); });
    $("btn-undo").addEventListener("click", deleteLast);

    $("search").addEventListener("input", renderRecords);
    $("date-filter").addEventListener("change", renderRecords);

    $("e-save").addEventListener("click", saveEdit);
    $("e-cancel").addEventListener("click", closeSheet);
    $("e-delete").addEventListener("click", function () {
      if (!editing) return;
      deleteRecord(editing, true).then(function (ok) { if (ok) { closeSheet(); renderRecords(); } });
    });
    $("sheet").addEventListener("click", function (e) { if (e.target === $("sheet")) closeSheet(); });

    $("btn-export-today").addEventListener("click", function () { exportDay(today()); });
    $("btn-export-month").addEventListener("click", function () {
      var m = $("export-month").value;
      if (!m) { toast("No records yet", "err"); return; }
      exportMonth(m);
    });
    $("btn-export-day").addEventListener("click", function () {
      var d = $("export-day").value;
      if (!d) { toast("No records yet", "err"); return; }
      exportDay(d);
    });
    $("btn-export-all").addEventListener("click", exportAll);
    $("btn-banner-month").addEventListener("click", function () { exportMonth(this.getAttribute("data-month")); });
    $("btn-backup").addEventListener("click", backup);
    $("restore-file").addEventListener("change", function () {
      var f = this.files && this.files[0];
      if (f) restore(f);
      this.value = "";
    });
    $("btn-wipe").addEventListener("click", moveAllToBin);
    $("btn-bin-restore-all").addEventListener("click", function () { restoreFromBin(bin()); });
    $("btn-bin-empty").addEventListener("click", emptyBin);

    $("s-digits").addEventListener("change", function () {
      settings.idDigitsOnly = this.checked; saveSettings(); checkForm();
      $("f-id").setAttribute("inputmode", settings.idDigitsOnly ? "numeric" : "text");
      $("e-id").setAttribute("inputmode", settings.idDigitsOnly ? "numeric" : "text");
    });
    function lenChange() {
      var lo = parseInt($("s-min").value, 10), hi = parseInt($("s-max").value, 10);
      if (!(lo >= 1 && lo <= 50)) lo = DEFAULTS.idMin;
      if (!(hi >= 1 && hi <= 50)) hi = DEFAULTS.idMax;
      if (hi < lo) hi = lo;
      settings.idMin = lo; settings.idMax = hi; saveSettings();
      $("s-min").value = lo; $("s-max").value = hi; checkForm();
    }
    $("s-min").addEventListener("change", lenChange);
    $("s-max").addEventListener("change", lenChange);

    var inputmode = settings.idDigitsOnly ? "numeric" : "text";
    $("f-id").setAttribute("inputmode", inputmode);
    $("e-id").setAttribute("inputmode", inputmode);

    // refresh "today" when the app comes back (e.g. after midnight)
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshSummary(); });
  }

  function loaded(list, fromDb) {
    var mirror = readMirror();
    var merged = mergeLists(list || [], mirror);
    var inDb = {}; (list || []).forEach(function (r) { inDb[r.uid] = r.updatedAt || r.ts; });
    // anything the database is missing (or has an older version of) is written back to it
    var fix = merged.filter(function (r) { return inDb[r.uid] === undefined || inDb[r.uid] < (r.updatedAt || r.ts); });
    records = merged;
    writeMirror();
    if (fromDb && fix.length) {
      dbPutMany(fix).then(function () {
        toast("Recovered " + plural(fix.length, "record") + " from the safety copy", "ok");
      }).catch(function () { /* the safety copy still has them */ });
    }
    refreshSummary();
  }

  function start() {
    wire();
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (ios && !isStandalone()) $("banner-install").classList.remove("hidden");

    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(function (p) { persisted = !!p; }).catch(function () { /* ignore */ });
    }
    if (!window.indexedDB) { loaded([], false); return; }
    openDb().then(function (d) {
      db = d;
      db.onversionchange = function () { db.close(); db = null; };
      return dbAll();
    }).then(function (list) { loaded(list, true); }).catch(function () {
      db = null;
      loaded([], false); // keep working from the safety copy
    });

    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("sw.js").catch(function () { /* offline cache is optional */ });
    }
  }

  // tiny hooks for automated tests
  window.__pl = { records: function () { return records; }, live: live, bin: bin, applyParse: applyParse,
    settings: function () { return settings; } };
  start();
})();
