// Turns raw OCR text from a business card into contact fields.
// Heuristic, tuned for shipping / business cards (Norwegian + international).
(function (root) {
  const COUNTRY_CODES = {
    "47": "Norway", "46": "Sweden", "45": "Denmark", "358": "Finland", "354": "Iceland",
    "44": "United Kingdom", "353": "Ireland", "49": "Germany", "31": "Netherlands", "32": "Belgium",
    "33": "France", "34": "Spain", "39": "Italy", "41": "Switzerland", "43": "Austria", "377": "Monaco",
    "30": "Greece", "357": "Cyprus", "90": "Turkey", "48": "Poland", "351": "Portugal", "380": "Ukraine",
    "1": "USA", "52": "Mexico", "55": "Brazil", "65": "Singapore", "852": "Hong Kong", "86": "China",
    "81": "Japan", "82": "South Korea", "91": "India", "971": "United Arab Emirates", "974": "Qatar",
    "966": "Saudi Arabia", "60": "Malaysia", "62": "Indonesia", "63": "Philippines", "66": "Thailand",
    "84": "Vietnam", "61": "Australia", "27": "South Africa", "20": "Egypt", "234": "Nigeria"
  };
  const COUNTRY_NAMES = ["Norway","Norge","Sweden","Sverige","Denmark","Danmark","Finland","Iceland","United Kingdom","UK","England","Scotland","Ireland","Germany","Deutschland","Netherlands","The Netherlands","Holland","Belgium","France","Spain","Italy","Switzerland","Austria","Monaco","Greece","Cyprus","Turkey","Türkiye","Poland","Portugal","USA","U.S.A.","United States","Canada","Mexico","Brazil","Singapore","Hong Kong","China","Japan","Korea","South Korea","India","UAE","United Arab Emirates","Dubai","Qatar","Saudi Arabia","Malaysia","Indonesia","Philippines","Thailand","Vietnam","Australia","South Africa","Egypt","Nigeria"];
  const TITLE_WORDS = /\b(broker|shipbroker|chartering|charterer|manager|director|ceo|cfo|coo|cto|chief|head|partner|founder|owner|president|vice|vp|analyst|associate|executive|officer|operator|operations|captain|master|superintendent|engineer|consultant|advisor|adviser|trainee|assistant|secretary|coordinator|specialist|lead|senior|junior|sr\.?|jr\.?|accountant|lawyer|counsel|attorney|sales|marketing|commercial|technical|fleet|desk|s&p|sale\s*&\s*purchase|tanker|dry\s*bulk|daglig leder|megler|skipsmegler|leder|sjef|rådgiver|konsulent|direktør|avdelingsleder|salgssjef|controller|trader|surveyor|agent|representative|manning|crewing|purchasing|procurement|hr|legal|finance|it)\b/i;
  const COMPANY_WORDS = /(\bAS\b|\bASA\b|\bA\/S\b|\bAB\b|\bApS\b|\bOy\b|\bLtd\.?|\bLimited\b|\bInc\.?|\bLLC\b|\bLLP\b|\bPLC\b|\bGmbH\b|\bAG\b|\bS\.?A\.?\b|\bB\.?V\.?\b|\bN\.?V\.?\b|\bPte\b|\bCo\.|\bCorp\.?|\bCorporation\b|\bCompany\b|\bShipping\b|\bShipbrokers?\b|\bShipbroking\b|\bMaritime\b|\bTankers?\b|\bCarriers?\b|\bGroup\b|\bHolding\b|\bMarine\b|\bLines\b|\bLogistics\b|\bNavigation\b|\bBank\b|\bCapital\b|\bPartners\b|\bAdvokatfirma\b|\bSE\b|\bOffshore\b|\bEnergy\b|\bGas\b|\bChemicals?\b)/i;
  const STREET_WORDS = /\b(\w*gate|\w*gata|\w*gaten|\w*veien|\w*vegen|\w*vei|\w*veg|vn\.?|\w*plass|\w*plassen|\w*brygge|\w*bryggen|\w*allé|\w*alle|\w*torget|\w*stranden|\w*kaia|street|st\.|road|rd\.?|avenue|ave\.?|boulevard|blvd|lane|way|square|place|drive|quay|wharf|house|building|tower|floor|suite|level|p\.?\s?o\.?\s?box|postboks|pb\.?|strasse|straße|str\.|weg|laan|straat|gade|vej|vägen|gatan|odos|leof)\b/i;
  const GENERIC_MAIL = /^(gmail|hotmail|outlook|live|yahoo|icloud|me|online|msn|aol|proton|protonmail|mail)$/i;

  const titleCase = s => s.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const fixCaps = s => (s === s.toUpperCase() && /[A-ZÆØÅ]{3}/.test(s)) ? titleCase(s) : s;

  function cleanLine(l) {
    return l.replace(/[|•·▪►■◆●_~"“”]+/g, " ").replace(/\s+/g, " ").replace(/^[\s\-–—:;,.]+|[\s\-–—:;,]+$/g, "").trim();
  }

  function normPhone(raw, defaultCC) {
    let s = raw.replace(/[()]/g, " ").replace(/[^\d+\s.-]/g, "").trim();
    s = s.replace(/^00/, "+");
    let digits = s.replace(/\D/g, "");
    if (!s.startsWith("+")) {
      if (defaultCC === "47" && digits.length === 8)
        return "+47 " + (/^[49]/.test(digits) ? digits.replace(/(\d{3})(\d{2})(\d{3})/, "$1 $2 $3") : digits.replace(/(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4"));
      return s.replace(/[.\-]/g, " ").replace(/\s+/g, " ").trim();
    }
    if (/^\+\s?47/.test(s)) {
      const n = s.replace(/\D/g, "").replace(/^47/, "");
      if (n.length === 8) return "+47 " + (/^[49]/.test(n) ? n.replace(/(\d{3})(\d{2})(\d{3})/, "$1 $2 $3") : n.replace(/(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4"));
    }
    // +47 (0) 22 ... → drop the (0)
    s = s.replace(/^\+(\d{1,3})\s*0\s+/, "+$1 ");
    return s.replace(/[.\-]/g, " ").replace(/\s+/g, " ").trim();
  }
  function ccOf(phone) {
    const d = phone.replace(/\s/g, "");
    if (!d.startsWith("+")) return null;
    for (const len of [3, 2, 1]) { const c = d.slice(1, 1 + len); if (COUNTRY_CODES[c]) return c; }
    return null;
  }

  function parseCard(text) {
    const out = { firstName: "", lastName: "", company: "", title: "", mobile: "", phone: "", email: "", website: "", street: "", postcode: "", city: "", country: "", note: "" };
    const extras = [];
    let lines = String(text || "").split(/\r?\n/).map(cleanLine).filter(l => l.length > 1)
      .map(l => l.replace(/\b[wW]{1,2}\s?[wW]{1,2}\s?\.\s?/g, m => /^[wW]\s?[wW]\s?[wW]\s?\.?\s?$|^[wW]{2}\s[wW]\.\s?$|^[wW]\s[wW]{2}\.\s?$|^[wW]{3}\.\s?$/.test(m) ? "www." : m))
      .map(l => l.replace(/\bwww\s*[,\s]\s*(?=[a-z0-9])/gi, "www."))
      // "x@steem 1960.com" → rejoin an email domain that OCR split with a space
      .map(l => l.replace(/@\s*([^\s@]+(?:\s+[^\s@]+){0,3})/, (m, rest) => {
        const t = rest.split(/\s+/); let dom = "", i = 0;
        for (; i < Math.min(t.length, 3); i++) { dom += t[i]; if (/\.[a-z]{2,}$/i.test(dom)) { i++; break; } }
        return /\.[a-z]{2,}$/i.test(dom) ? "@" + dom + (t.slice(i).length ? " " + t.slice(i).join(" ") : "") : m;
      }))
      // "lars nilsen@x.com" → OCR often reads the dot in an email as a space
      .map(l => l.replace(/(^|\s)([a-z]{2,15})\s([a-z0-9][a-z0-9._%+\-]*@)/g, (m, a, b, c) => /^(e|mail|email|epost)$/i.test(b) ? m : a + b + "." + c));
    const used = new Set();

    // --- email ---
    const emailRe = /([A-Za-z0-9._%+\-]+)\s?(?:@|\(at\))\s?([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})/;
    lines.forEach((l, i) => {
      const m = l.replace(/\s*\.\s*/g, ".").match(emailRe);
      if (!m) return;
      const em = (m[1] + "@" + m[2]).toLowerCase();
      if (!out.email) out.email = em; else extras.push("Email: " + em);
      const rest = cleanLine(l.replace(/\s*\.\s*/g, ".").replace(m[0], "").replace(/^(e-?mail|e|mail)\s*[:.]?\s*/i, ""));
      if (rest.length > 2) lines[i] = rest; else used.add(i);
    });

    // --- phones (collect first, so we know the country) ---
    const phoneRe = /(\+?\s?\(?\d[\d\s().\-]{6,}\d)/g;
    const phones = [];
    lines.forEach((l, i) => {
      if (used.has(i)) return;
      let consumed = l;
      for (const m of l.matchAll(phoneRe)) {
        const digits = m[1].replace(/\D/g, "");
        if (digits.length < 8 || digits.length > 15) continue;
        // skip things that look like org numbers / postcodes inside addresses
        if (/\b(org|org\.?nr|vat|mva|reg)\b/i.test(l)) continue;
        const before = l.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
        let kind = "phone";
        if (/(fax|\bf\s*[:.]?\s*$)/.test(before)) kind = "fax";
        else if (/(mob|cell|gsm|whatsapp|wa\b|\bm\s*[:.]?\s*$|\bc\s*[:.]?\s*$|mobil)/.test(before)) kind = "mobile";
        else if (/(direct|dir\b|\bd\s*[:.]?\s*$|dl\b)/.test(before)) kind = "direct";
        phones.push({ raw: m[1], kind });
        consumed = consumed.replace(m[0], " ");
      }
      if (phones.length && consumed !== l) {
        const rest = cleanLine(consumed.replace(/\b(tel|telephone|phone|ph|mob|mobile|mobil|cell|direct|dir|fax|office|switchboard|sentralbord|t|m|d|f|p|c)\b\.?\s*[:.]?/gi, " "));
        if (rest.length > 3 && /\p{L}{3,}/u.test(rest)) lines[i] = rest; else used.add(i);
      }
    });

    // --- website ---
    const webRe = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9\-]*(?:\.[a-z0-9\-]+)*\.(?:com|no|net|org|co|uk|se|dk|fi|de|gr|sg|io|biz|info|nl|eu|ch|fr|it|es|jp|cn|hk|ae|us|ca|au|kr|in|be|at|pl|pt|cy|mc|tr|global|group|shipping|energy)(?:\/[^\s]*)?)\b/i;
    lines.forEach((l, i) => {
      if (used.has(i) || out.website) return;
      const t = l.replace(/\s*\.\s*/g, ".");
      const m = t.match(webRe);
      if (!m) return;
      if (/^(www\.|https?:)/i.test(m[1]) || /^(web|www|w)\s*[:.]/i.test(t) || t.length <= m[1].length + 6) {
        out.website = m[1].replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
        const rest = cleanLine(t.replace(m[0], "").replace(/^(web|www|w)\s*[:.]?/i, ""));
        if (rest.length > 2) lines[i] = rest; else used.add(i);
      }
    });

    // --- country from lines ---
    lines.forEach((l, i) => {
      if (used.has(i) || out.country) return;
      for (const c of COUNTRY_NAMES) {
        const re = new RegExp("(^|[\\s,\\-])" + c.replace(/\./g, "\\.") + "$", "i");
        if (re.test(l)) {
          out.country = { Norge: "Norway", Sverige: "Sweden", Danmark: "Denmark", Deutschland: "Germany", "UK": "United Kingdom", "England": "United Kingdom", "USA": "USA", "U.S.A.": "USA", "United States": "USA", "Holland": "Netherlands", "The Netherlands": "Netherlands", "UAE": "United Arab Emirates", "Dubai": "United Arab Emirates", "Türkiye": "Turkey" }[c] || c;
          const rest = cleanLine(l.replace(re, ""));
          if (rest.length > 2) lines[i] = rest; else used.add(i);
          return;
        }
      }
    });

    // --- address: postcode + city ---
    const postRes = [
      /^(?:(?:N|NO|S|SE|DK|D|FIN)\s?[-–]\s?)?(\d{4,5})\s+([\p{L}][\p{L}\s.\-]{1,30})$/u,        // 0250 Oslo, N-0250 Oslo, 10115 Berlin
      /^(.+?)[,\s]+(?:(?:N|NO|S|SE|DK)\s?[-–]\s?)?(\d{4,5})\s+([\p{L}][\p{L}\s.\-]{1,30})$/u,     // Street 1, 0250 Oslo
      /^([\p{L}][\p{L}\s.\-]{1,30}?)[,\s]+([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/u,                  // London EC2V 7HN
      /^([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\s+([\p{L}][\p{L}\s.\-]{1,30})$/u,                      // EC2V 7HN London
      /^([\p{L}][\p{L}\s.\-]{1,30}?)\s+(\d{5,6})$/u                                                 // Singapore 018989
    ];
    let addrLine = -1;
    lines.forEach((l, i) => {
      if (used.has(i) || out.postcode) return;
      let m;
      m = l.match(postRes[1]);
      if (m && /^(postboks|pb\.?|p\.?\s?o\.?\s?box)$/i.test(m[1].trim())) m = null;
      if (m && (STREET_WORDS.test(m[1]) || /\d/.test(m[1]))) {
        if (m) { out.street = m[1].replace(/,$/, ""); out.postcode = m[2]; out.city = fixCaps(m[3].trim()); used.add(i); addrLine = i; return; }
      }
      if ((m = l.match(postRes[0]))) { out.postcode = m[1]; out.city = fixCaps(m[2].trim()); used.add(i); addrLine = i; return; }
      if ((m = l.match(postRes[2]))) { out.city = fixCaps(m[1].trim()); out.postcode = m[2]; used.add(i); addrLine = i; return; }
      if ((m = l.match(postRes[3]))) { out.postcode = m[1]; out.city = fixCaps(m[2].trim()); used.add(i); addrLine = i; return; }
      if ((m = l.match(postRes[4])) && /singapore|hong kong|beijing|shanghai|seoul|tokyo|mumbai/i.test(m[1])) { out.city = fixCaps(m[1].trim()); out.postcode = m[2]; used.add(i); addrLine = i; }
    });
    // street: a line with a street word or "Word 12"
    if (!out.street) {
      const order = [...lines.keys()].sort((a, b) => Math.abs(a - addrLine) - Math.abs(b - addrLine));
      for (const i of order) {
        if (used.has(i)) continue;
        const l = lines[i];
        if (STREET_WORDS.test(l) && (/\d/.test(l) || addrLine >= 0 && i === addrLine - 1) || /^[\p{L}][\p{L}.\s\-]+\s\d{1,4}[A-Za-z]?(,.*)?$/u.test(l) && addrLine >= 0 && Math.abs(i - addrLine) <= 2 || /^(p\.?\s?o\.?\s?box|postboks|pb\.?)\s*\d+/i.test(l)) {
          out.street = l.replace(/,$/, ""); used.add(i); break;
        }
      }
    }

    // --- phones now that we may know the country ---
    let defaultCC = null;
    if (/norway/i.test(out.country) || /^\d{4}$/.test(out.postcode) && !out.country) defaultCC = "47";
    for (const p of phones) {
      const num = normPhone(p.raw, defaultCC);
      if (p.kind === "fax") { extras.push("Fax: " + num); continue; }
      if (p.kind === "mobile" && !out.mobile) out.mobile = num;
      else if (!out.phone) out.phone = num;
      else if (!out.mobile) out.mobile = num;
      else extras.push("Phone: " + num);
    }
    // Norwegian mobiles start with 4 or 9: if only "phone" was found and it looks like a mobile, move it
    if (!out.mobile && out.phone && /^\+47\s?[49]/.test(out.phone)) { out.mobile = out.phone; out.phone = ""; }
    if (!out.country) { const cc = ccOf(out.mobile || out.phone); if (cc) out.country = COUNTRY_CODES[cc]; }

    // --- title / company / name from what's left ---
    const rest = lines.map((l, i) => ({ l, i })).filter(x => !used.has(x.i) && /\p{L}{2,}/u.test(x.l));
    const isNameLike = l => {
      const w = l.split(" ");
      if (w.length < 2 || w.length > 4) return false;
      if (/\d|@|&|\//.test(l)) return false;
      if (TITLE_WORDS.test(l) || COMPANY_WORDS.test(l) || STREET_WORDS.test(l)) return false;
      return w.every(x => /^(\p{Lu}[\p{L}'’\-.]*|van|von|de|der|den|da|di|la|le|du|af|bin|al)$/u.test(x));
    };

    // company
    let compIdx = -1;
    for (const x of rest) { if (COMPANY_WORDS.test(x.l) && !TITLE_WORDS.test(x.l.replace(COMPANY_WORDS, ""))) { compIdx = x.i; break; } }
    if (compIdx >= 0) {
      out.company = lines[compIdx]; used.add(compIdx);
      // a logo-style word right above a generic company line ("STEEM1960" + "Shipbrokers AS")
      const prev = compIdx - 1;
      if (prev >= 0 && !used.has(prev) && /^[\p{Lu}\d&.\-]{2,20}$/u.test(lines[prev]) && !/^\p{Lu}/u.test(out.company.replace(/^(Shipbrokers?|Shipping|Tankers?|Maritime|Marine|Group|Holding|Chartering|AS|ASA|Ltd\.?)\b.*/, "")) ) {
        out.company = lines[prev] + " " + out.company; used.add(prev);
      }
    }

    // name
    let nameIdx = -1;
    for (const x of rest) { if (!used.has(x.i) && isNameLike(x.l)) { nameIdx = x.i; break; } }
    if (nameIdx >= 0) {
      const n = fixCaps(lines[nameIdx]).replace(/\s*,.*$/, "");
      const parts = n.split(" ");
      // keep particles (van, von, de…) with the last name
      let cut = parts.length - 1;
      while (cut > 1 && /^(van|von|de|der|den|da|di|la|le|du|af|bin|al)$/i.test(parts[cut - 1])) cut--;
      out.firstName = parts.slice(0, cut).join(" ");
      out.lastName = parts.slice(cut).join(" ");
      used.add(nameIdx);
    }

    // title: lines with title words, near the name
    const titleLines = rest.filter(x => !used.has(x.i) && TITLE_WORDS.test(x.l) && x.l.length < 60)
      .sort((a, b) => Math.abs(a.i - nameIdx) - Math.abs(b.i - nameIdx));
    if (titleLines.length) {
      const t = titleLines.slice(0, 2).sort((a, b) => a.i - b.i);
      out.title = t.map(x => fixCaps(x.l)).join(", ");
      t.forEach(x => used.add(x.i));
    }

    // company fallback: email domain, or a remaining all-caps line
    if (!out.company) {
      const cand = rest.find(x => !used.has(x.i) && x.l === x.l.toUpperCase() && /\p{Lu}{3,}/u.test(x.l) && x.l.split(" ").length <= 5);
      if (cand) { out.company = cand.l; used.add(cand.i); }
    }
    if (!out.company && out.email) {
      const base = out.email.split("@")[1].split(".")[0];
      if (!GENERIC_MAIL.test(base)) out.company = base.length <= 4 ? base.toUpperCase() : titleCase(base);
    }
    if (out.company) out.company = out.company.replace(/\s+/g, " ");

    out.note = extras.join("\n");
    return out;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { parseCard };
  else root.parseCard = parseCard;
})(this);
