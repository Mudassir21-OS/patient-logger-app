/* Patient Logger - speech text parser (same rules as the Windows app's core.py).
   Turns "Name Ahmed Khan, ID 45872, age 45, male, diagnosis fever" - or just
   "Ahmed Khan 45872 45 male fever" - into fields. */
(function (root) {
  "use strict";

  var UNITS = { zero: 0, oh: 0, o: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, "for": 4,
    five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  var TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  var TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  var REPEAT = { "double": 2, triple: 3 };
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  var COMMANDS = {
    "save": "save", "save it": "save", "confirm": "save", "ok save": "save", "okay save": "save",
    "cancel": "clear", "clear": "clear", "next": "clear", "next patient": "clear",
    "delete last": "delete_last", "undo": "delete_last", "undo last": "delete_last",
    "remove last": "delete_last", "delete the last one": "delete_last", "delete last entry": "delete_last"
  };

  var NAME_RE = "(?:patient'?s?\\s+)?(?:full\\s+)?name(?:\\s+is)?";
  var ID_RE = "(?:patient'?s?\\s+)?(?:id(?:\\s+number)?|mrn|file\\s+number|number)(?:\\s+is)?";
  var AGE_RE = "(?:patient'?s?\\s+)?age(?:\\s+is)?";
  var GENDER_RE = "(?:patient'?s?\\s+)?(?:gender|sex)(?:\\s+is)?";
  var DIAG_RE = "(?:diagnos[ie]s|diagnosed(?:\\s+with)?|dx|notes?|comments?|complaint|complaining\\s+of|presenting\\s+with)" +
    "(?:\\s+(?:is|are|was|of))?";
  var KINDS = ["name", "id", "age", "gender", "diagnosis"];
  var MARKERS_SRC = "\\b(" + NAME_RE + ")\\b|\\b(" + ID_RE + ")\\b|\\b(" + AGE_RE + ")\\b|\\b(" +
    GENDER_RE + ")\\b|\\b(" + DIAG_RE + ")\\b";

  var GENDER_WORDS = { male: "Male", man: "Male", boy: "Male", m: "Male", gentleman: "Male",
    female: "Female", woman: "Female", girl: "Female", f: "Female", lady: "Female", other: "Other" };
  var W_UNIT = "one|two|three|four|five|six|seven|eight|nine";
  var W_TEEN = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
  var W_TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
  var AGE_NUM = "(?:\\d{1,3}|(?:" + W_TENS + ")(?:[\\s-]+(?:" + W_UNIT + "))?|" + W_TEEN + "|" + W_UNIT + "|hundred)";
  var AGE_PHRASE_SRC = "\\b(?:aged\\s+)?" + AGE_NUM +
    "[\\s-]*(?:(?:years?|yrs?)(?:[\\s-]*old)?|y\\/?o|months?[\\s-]*old)\\b";
  var AGE_LEAD = new RegExp("^\\s*[,.:]?\\s*" + AGE_NUM +
    "(?:[\\s-]*(?:(?:years?|yrs?)(?:[\\s-]*old)?|y\\/?o|months?(?:[\\s-]*old)?))?", "i");
  var MONTHS_OLD = new RegExp("\\b(" + AGE_NUM + ")[\\s-]*months?[\\s-]*(?:old)?\\b", "i");
  var UNIT_TAIL = "(?:[\\s-]+(?:" + W_UNIT + "))?";
  var BARE_GENDER_SRC = "\\b(male|female|man|woman|boy|girl|gentleman|lady)\\b";
  var AGE_WORDS_SRC = "\\b(?:(?:" + W_TENS + ")(?:[\\s-]+(?:" + W_UNIT + "))?|" + W_TEEN + "|" + W_UNIT + ")\\b";
  var D_WORDS = "double|triple|zero|oh|one|two|three|four|five|six|seven|eight|nine";
  // an ID read out in words: "four five eight seven two", "double four seven five five" (4+ words)
  var WORD_DIGITS_SRC = "\\b(?:" + D_WORDS + ")\\b(?:[\\s,-]+\\b(?:" + D_WORDS + ")\\b){3,}";
  var ALNUM_ID_SRC = "\\b[A-Za-z]{1,3}\\d{3,}\\b";
  var NUMGROUP_SRC = "\\b\\d\\b(?:[\\s-]+\\b\\d\\b)+|\\b\\d+(?:[,-]\\d+)*\\b";
  var ID_TOKEN = new RegExp("\\s*([,\\-]\\s*)?(?:(\\d+(?:[,\\-]\\d+)*)|([A-Za-z]\\d+)|(zero|oh|o|one|two|to|too|three|" +
    "four|for|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|" +
    "nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|double|triple))\\b", "iy");
  var AMBIGUOUS_NUMWORDS = ["o", "to", "too", "for"];
  var FILLER = {};
  ("and he she is was the patient patients a an aged age years year yrs old of with his her name id " +
    "number gender sex it its this who has have having also um uh okay ok so then please").split(" ")
    .forEach(function (w) { FILLER[w] = 1; });
  var TITLES = ["mr", "mrs", "ms", "dr", "miss", "mst", "sr", "jr"];

  function simple(text) {
    return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean).join(" ");
  }

  function normaliseIdWords(text) {
    return text.replace(/\bi\.?\s?-?d\b\.?/gi, "ID").replace(/\bM\.?R\.?N\b\.?/gi, "MRN");
  }

  function wordsToDigits(text) {
    var tokens = text.match(/[A-Za-z]+|\d+/g) || [];
    var out = [], repeat = 1;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i], low = t.toLowerCase();
      if (/^\d+$/.test(t)) { out.push(t.repeat(repeat)); repeat = 1; }
      else if (has(REPEAT, low)) { repeat = REPEAT[low]; }
      else if (has(UNITS, low)) { out.push(String(UNITS[low]).repeat(repeat)); repeat = 1; }
      else if (has(TEENS, low)) { out.push(String(TEENS[low])); repeat = 1; }
      else if (has(TENS, low)) {
        var val = TENS[low];
        var nxt = i + 1 < tokens.length ? tokens[i + 1].toLowerCase() : "";
        if (has(UNITS, nxt) && UNITS[nxt] !== 0 && ["to", "too", "for", "o", "oh"].indexOf(nxt) < 0) {
          val += UNITS[nxt]; i++;
        }
        out.push(String(val)); repeat = 1;
      } else if (low === "hundred") {
        var n2 = i + 1 < tokens.length ? tokens[i + 1].toLowerCase() : "";
        if (!(has(UNITS, n2) || has(TEENS, n2) || has(TENS, n2) || /^\d+$/.test(n2))) out.push("00");
      } else if (["and", "dash", "hyphen", "slash", "is", "the", "number"].indexOf(low) >= 0) {
        /* skip */
      } else {
        out.push(t.toUpperCase());
      }
    }
    return out.join("");
  }

  function cleanId(raw, digitsOnly) {
    var s = wordsToDigits(raw);
    return digitsOnly ? s.replace(/\D/g, "") : s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  }

  function stripChars(s, chars) {
    var a = 0, b = s.length;
    while (a < b && chars.indexOf(s[a]) >= 0) a++;
    while (b > a && chars.indexOf(s[b - 1]) >= 0) b--;
    return s.slice(a, b);
  }
  function squash(s) { return s.split(/\s+/).filter(Boolean).join(" "); }
  function isUpper(s) { return s === s.toUpperCase() && s !== s.toLowerCase(); }

  function cleanName(raw) {
    var s = raw.replace(/[^\p{L}\p{M}\d_\s'\-.]/gu, " ");
    s = s.replace(/\d+/g, " ");
    s = stripChars(squash(s), " .-'");
    s = s.replace(/^(?:(?:the\s+)?patient'?s?\s+)?(?:(?:is|of)\s+)?/i, "");
    s = s.replace(/\s+(?:and|then)$/i, "");
    if (s && isUpper(s)) s = s.toLowerCase();
    return s.split(/\s+/).filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
  }

  function cleanDiagnosis(raw) {
    var s = stripChars(squash(raw), " ,;:-.");
    s = stripChars(s.replace(/[\s,]*(?:and\s+)?(?:save|save it)\.?$/i, ""), " ,;:.");
    s = stripChars(s.replace(/^(?:(?:and|with|has|having|is|was|the|he|she|patient|also|of)\b[\s,]*)+/i, ""), " ,;:.");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function parseSpelling(text) {
    var body = text.replace(/^\s*spell(?:ing)?(?:\s+(?:the|it|name|the\s+name))*\s*[:,.]?\s*/i, "");
    var words = [], current = "";
    body.split(/[\s,.\-]+/).forEach(function (tok) {
      if (!tok) return;
      var low = tok.toLowerCase();
      if (["space", "next", "surname", "then"].indexOf(low) >= 0) {
        if (current) { words.push(current); current = ""; }
      } else if (low === "save" || low === "and") {
        /* skip */
      } else if (tok.length === 1 && /[A-Za-z]/.test(tok)) {
        current += tok;
      } else if (/^[A-Za-z]'?$/.test(tok)) {
        current += tok[0];
      } else {
        if (current) { words.push(current); current = ""; }
        words.push(tok.replace(/[^A-Za-z']/g, ""));
      }
    });
    if (current) words.push(current);
    return words.filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join(" ");
  }

  function cleanAge(raw) {
    var m = MONTHS_OLD.exec(raw);
    if (m) {
      var mv = wordsToDigits(m[1]);
      return /^\d+$/.test(mv) && +mv > 0 && +mv < 24 ? String(+mv) + "m" : "";
    }
    m = new RegExp(AGE_NUM + UNIT_TAIL, "i").exec(raw);
    if (!m) return "";
    var v = wordsToDigits(m[0]);
    return /^\d+$/.test(v) ? String(parseInt(v, 10)) : "";
  }

  function cleanGender(raw) {
    var toks = raw.match(/[A-Za-z]+/g) || [];
    for (var i = 0; i < toks.length; i++) {
      var k = toks[i].toLowerCase();
      if (has(GENDER_WORDS, k)) return GENDER_WORDS[k];
    }
    return "";
  }

  // ---------------------------------------------------------------- free-speech helpers
  function words(text) { return text.match(/[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)?/gu) || []; }
  function isFiller(text) {
    return words(text).every(function (w) { return has(FILLER, w.toLowerCase()); });
  }
  function firstClause(text) {
    var re = /[,;]|\.(?=\s|$)/g, m;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === ".") {
        var before = /[A-Za-z]+$/.exec(text.slice(0, m.index));
        if (before && TITLES.indexOf(before[0].toLowerCase()) >= 0) continue;
      }
      return [text.slice(0, m.index), text.slice(m.index + m[0].length)];
    }
    return [text, ""];
  }
  function overlaps(spans, s, e) {
    return spans.some(function (x) { return x[0] < e && s < x[1]; });
  }
  function findSpans(text) {
    var spans = [], m, re;
    re = new RegExp(AGE_PHRASE_SRC, "gi");
    while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length, "age", m[0]]);
    re = new RegExp(BARE_GENDER_SRC, "gi");
    while ((m = re.exec(text)) !== null) {
      if (!overlaps(spans, m.index, m.index + m[0].length)) spans.push([m.index, m.index + m[0].length, "gender", m[0]]);
    }
    [new RegExp(ALNUM_ID_SRC, "g"), new RegExp(WORD_DIGITS_SRC, "gi")].forEach(function (rx) {
      var mm;
      while ((mm = rx.exec(text)) !== null) {
        if (!overlaps(spans, mm.index, mm.index + mm[0].length)) spans.push([mm.index, mm.index + mm[0].length, "num", mm[0]]);
      }
    });
    re = new RegExp(NUMGROUP_SRC, "g");
    while ((m = re.exec(text)) !== null) {
      if (!overlaps(spans, m.index, m.index + m[0].length)) spans.push([m.index, m.index + m[0].length, "num", m[0]]);
    }
    re = new RegExp(AGE_WORDS_SRC, "gi"); // "forty five" said without "age"
    while ((m = re.exec(text)) !== null) {
      if (!overlaps(spans, m.index, m.index + m[0].length)) spans.push([m.index, m.index + m[0].length, "age", m[0]]);
    }
    return spans.sort(function (a, b) { return a[0] - b[0]; });
  }

  function extractId(full, idMin) {
    var age = new RegExp(AGE_PHRASE_SRC, "i").exec(full); // never let the ID run into "... 45 years old"
    var body = age ? full.slice(0, age.index) : full;
    var lead = /^[\s,.:;]*/.exec(body)[0].length;
    var pos = lead, mode = null, acc = "", allSingle = true;
    for (;;) {
      ID_TOKEN.lastIndex = pos;
      var m = ID_TOKEN.exec(body);
      if (!m) break;
      var sep = m[1] || "";
      if (acc && /^[\s-]*(?:years?|yrs?|y\/?o|months?)\b/i.test(body.slice(m.index + m[0].length))) {
        break; // "ID 4 5 8 7 2 6 months old": the 6 is the age
      }
      if (m[2]) {
        if (mode === "words" || sep.indexOf(",") >= 0) break;
        var digits = m[2].replace(/\D/g, "");
        var single = m[2].length === 1;
        if (acc && !(allSingle && single) && acc.length >= idMin) break;
        allSingle = allSingle && single;
        acc += digits;
        mode = "digits";
      } else if (m[3]) {
        if (acc || mode) break;
        acc += m[3]; allSingle = false; mode = "digits";
      } else {
        var w = m[4].toLowerCase();
        if (mode === "digits" || (mode === null && AMBIGUOUS_NUMWORDS.indexOf(w) >= 0)) break;
        mode = "words";
      }
      pos = m.index + m[0].length;
    }
    return [body.slice(lead, pos), full.slice(pos)];
  }

  function extractKeyed(kind, body, idMin) {
    var m;
    if (kind === "id") return extractId(body, idMin);
    if (kind === "age") {
      m = AGE_LEAD.exec(body);
      return m ? [m[0], body.slice(m[0].length)] : ["", body];
    }
    if (kind === "gender") {
      m = /^\s*[,.:]?\s*([A-Za-z]+)/.exec(body);
      if (m && has(GENDER_WORDS, m[1].toLowerCase())) return [m[1], body.slice(m[0].length)];
      return ["", body];
    }
    if (kind === "name") {
      var spans = findSpans(body);
      var cut = spans.length ? spans[0][0] : body.length;
      var c = firstClause(body.slice(0, cut));
      return [c[0], c[1] + body.slice(cut)];
    }
    return [body, ""];
  }

  function parseUtterance(text, digitsOnly, idMin) {
    if (digitsOnly === undefined) digitsOnly = true;
    idMin = +idMin || 4;
    var result = { raw: text.trim() };
    var s = simple(text);
    if (!s) return result;
    if (has(COMMANDS, s)) { result.command = COMMANDS[s]; return result; }

    if (/^spell(ing)?\b/.test(s)) {
      var nm = parseSpelling(text);
      if (nm) result.name = nm;
      if (/\bsave(\s+it)?\s*$/.test(s)) result.save_after = true;
      return result;
    }

    if (/(?:^|\s)(?:and\s+)?save(?:\s+it)?$/.test(s)) {
      result.save_after = true;
      text = text.replace(/[\s,.]*(?:and\s+)?save(?:\s+it)?[\s.!]*$/i, "");
    }

    var t = normaliseIdWords(text);
    var re = new RegExp(MARKERS_SRC, "gi");
    var marks = [], m;
    while ((m = re.exec(t)) !== null) {
      if (m[0] === "") { re.lastIndex++; continue; }
      var kind = null;
      for (var k = 0; k < KINDS.length; k++) if (m[k + 1] !== undefined) { kind = KINDS[k]; break; }
      marks.push([m.index, m.index + m[0].length, kind]);
      if (kind === "diagnosis") break; // everything after "diagnosis" belongs to the diagnosis
    }

    // 1) keyed values (a keyword said twice: the later one wins)
    var keyed = {}, seq = [], keyedDiag = null, pos = 0;
    for (var i = 0; i < marks.length; i++) {
      if (marks[i][0] > pos) seq.push(["free", t.slice(pos, marks[i][0])]);
      var end = i + 1 < marks.length ? marks[i + 1][0] : t.length;
      var body = t.slice(marks[i][1], end);
      seq.push(["key", marks[i][2]]);
      if (marks[i][2] === "diagnosis") {
        keyedDiag = body;
      } else {
        var vr = extractKeyed(marks[i][2], body, idMin);
        if (stripChars(vr[0], " ,.:;")) keyed[marks[i][2]] = vr[0];
        if (vr[1].trim()) seq.push(["free", vr[1]]);
      }
      pos = end;
    }
    if (pos < t.length) seq.push(["free", t.slice(pos)]);

    // 2) free speech: name first, then numbers / ages / gender words, anything else = diagnosis
    var found = {};
    var haveF = function (key) { return has(keyed, key) || has(found, key); };
    var seenField = false, diagParts = [], inDiag = false;

    for (var j = 0; j < seq.length; j++) {
      if (seq[j][0] === "key") { seenField = true; continue; }
      var txt = seq[j][1];
      if (inDiag) { diagParts.push(txt); continue; }
      var cur = 0;
      var spans = findSpans(txt).concat([[txt.length, txt.length, null, null]]);
      for (var q = 0; q < spans.length; q++) {
        var sp = spans[q];
        var gap = txt.slice(cur, sp[0]);
        if (!isFiller(gap)) {
          if (!haveF("name") && !seenField) {
            var cl = firstClause(gap);
            if (!isFiller(cl[0])) { found.name = cl[0]; seenField = true; }
            if (!isFiller(cl[1])) { inDiag = true; diagParts.push(cl[1] + txt.slice(sp[0])); break; }
          } else {
            inDiag = true; diagParts.push(txt.slice(cur)); break;
          }
        }
        if (sp[2] === null) break;
        var ok = true;
        if (sp[2] === "gender") {
          if (!haveF("gender")) found.gender = sp[3];
        } else if (sp[2] === "age") {
          if (haveF("age")) ok = false; else found.age = sp[3];
        } else {
          var dg = wordsToDigits(sp[3]).replace(/\D/g, "");
          if (!haveF("id") && dg.length >= idMin) found.id = sp[3];
          else if (!haveF("age") && dg.length <= 3 && parseInt(dg, 10) <= 130) found.age = sp[3];
          else ok = false;
        }
        if (!ok) { inDiag = true; diagParts.push(txt.slice(sp[0])); break; }
        seenField = true;
        cur = sp[1];
      }
    }

    // a long number or a gender word said after the diagnosis started is still the ID / gender
    if (diagParts.length) {
      var dtext = diagParts.join(" ");
      if (!haveF("id")) {
        var nre = new RegExp(NUMGROUP_SRC, "g"), nm2;
        while ((nm2 = nre.exec(dtext)) !== null) {
          if (nm2[0].replace(/\D/g, "").length >= idMin) {
            found.id = nm2[0];
            dtext = dtext.slice(0, nm2.index) + " " + dtext.slice(nm2.index + nm2[0].length);
            break;
          }
        }
      }
      if (!haveF("gender")) {
        var gm = new RegExp(BARE_GENDER_SRC, "i").exec(dtext);
        if (gm) {
          found.gender = gm[0];
          dtext = dtext.slice(0, gm.index) + " " + dtext.slice(gm.index + gm[0].length);
        }
      }
      diagParts = [dtext];
    }

    var get = function (key) { return has(keyed, key) ? keyed[key] : found[key]; };
    if (get("name")) { var n = cleanName(get("name")); if (n) result.name = n; }
    if (get("id")) { var p = cleanId(get("id"), digitsOnly); if (p) result.id = p; }
    if (get("age")) { var a = cleanAge(get("age")); if (a) result.age = a; }
    if (get("gender")) { var g = cleanGender(get("gender")); if (g) result.gender = g; }
    var diag = diagParts.length ? [cleanDiagnosis(diagParts.join(" "))] : [];
    if (keyedDiag !== null) diag.push(cleanDiagnosis(keyedDiag));
    diag = diag.filter(Boolean).join(", ");
    if (diag) result.diagnosis = diag;
    return result;
  }

  function validateId(pid, cfg) {
    if (!pid) return "Patient ID is empty.";
    if (cfg.idDigitsOnly && !/^\d+$/.test(pid)) return "Patient ID must contain digits only.";
    var lo = +cfg.idMin || 1, hi = +cfg.idMax || 50;
    if (pid.length < lo || pid.length > hi) return "Patient ID has " + pid.length + " characters; expected " + lo + "-" + hi + ".";
    return null;
  }

  function validateAge(age) {
    if (!age) return null;
    var a = String(age).trim().toLowerCase();
    if (/^\d{1,3}$/.test(a) && +a <= 130) return null;
    if (/^\d{1,2}\s*m$/.test(a) && parseInt(a, 10) < 24) return null;
    return "Age must be a number 0-130 (or months like 6m).";
  }

  var api = { parseUtterance: parseUtterance, validateId: validateId, validateAge: validateAge,
    wordsToDigits: wordsToDigits };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PatientParser = api;
})(typeof self !== "undefined" ? self : this);
