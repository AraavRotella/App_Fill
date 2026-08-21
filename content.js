// content.js — injected on demand when you click "Fill this page".
// Scans visible form fields, matches them to your profile, and fills them
// in a way that React-based ATS forms (Workday, Greenhouse, Lever, Ashby) accept.
//
// Ashby notes (jobs.ashbyhq.com):
//   - Yes/No questions render as PAIRS OF <button type="submit"> with no role,
//     no name, no id, and no aria-label. They are invisible to a
//     querySelectorAll("input, textarea, select") scan, so they are discovered
//     structurally in collectYesNoGroups().
//   - Typeahead fields are <input role="combobox">. Setting .value alone does
//     not commit a selection; the listbox option must be clicked.
//   - Core fields use name/id like "_systemfield_name"; custom fields use bare
//     UUIDs, so label text is the only reliable signal for those.

(() => {
  if (window.__appfillLoaded) return;
  window.__appfillLoaded = true;
  console.log("APPFILL LOADED, url:", location.href);

  // ---------- Text normalization ----------
  // Strips required-asterisks, non-breaking spaces, and (required)/(optional)
  // suffixes so anchored regexes like /^name$/ can actually match.

  function normalize(s) {
    return (s || "")
      .replace(/[\u00a0*]/g, " ")
      .replace(/\((required|optional)\)/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // ---------- Field discovery ----------

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Tight label only: the element's own <label>, aria-label, or aria-labelledby.
  // Never falls back to container text, so sibling controls in a shared wrapper
  // cannot inherit each other's text.
  function ownLabelText(el) {
    const parts = [];
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) parts.push(lab.innerText);
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) parts.push(wrappingLabel.innerText);
    if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach((id) => {
        const ref = document.getElementById(id);
        if (ref) parts.push(ref.innerText);
      });
    }
    return normalize(parts.join(" "));
  }

  // Loose label: tight label if present, otherwise nearest container text.
  // Used for matching only, never for deciding which radio/button to click.
  function labelTextFor(el) {
    const own = ownLabelText(el);
    if (own) return own;
    const container = el.closest("div, td, li, fieldset");
    if (container) return normalize(container.innerText.slice(0, 160));
    return "";
  }

  // Walks up from a control looking for the question text that introduces it.
  // Used for Ashby Yes/No groups and unlabeled comboboxes.
  function questionTextFor(el) {
    let node = el;
    for (let i = 0; i < 6; i++) {
      node = node.parentElement;
      if (!node) break;
      const txt = (node.innerText || "")
        .replace(/\b(yes|no)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (txt.length > 3 && txt.length < 300) return normalize(txt);
    }
    return "";
  }

  function collectStandardFields() {
    const els = Array.from(
      document.querySelectorAll("input, textarea, select")
    ).filter((el) => {
      if (!isVisible(el)) return false;
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "image", "file", "password"].includes(type)) return false;
      if (el.readOnly || el.disabled) return false;
      return true;
    });

    return els.map((el, i) => {
      const role = (el.getAttribute("role") || "").toLowerCase();
      const isCombobox = role === "combobox";
      return {
        el,
        custom: isCombobox ? "combobox" : null,
        index: i,
        tag: el.tagName.toLowerCase(),
        type: (el.type || "").toLowerCase(),
        role,
        name: (el.name || "").toLowerCase(),
        id: (el.id || "").toLowerCase(),
        autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
        // placeholder is kept OUT of label so "Type here..." cannot pollute matching
        placeholder: normalize(el.placeholder),
        label: isCombobox
          ? labelTextFor(el) || questionTextFor(el)
          : labelTextFor(el),
        options:
          el.tagName === "SELECT"
            ? Array.from(el.options).map((o) => o.text.trim())
            : null,
      };
    });
  }

  // Ashby-style Yes/No: two sibling <button> elements whose text is exactly
  // "Yes" and "No". Grouped by nearest ancestor containing exactly that pair.
  function collectYesNoGroups() {
    const yesNoButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => isVisible(b) && ["yes", "no"].includes(normalize(b.innerText))
    );

    const groups = [];
    const seen = new Set();

    for (const btn of yesNoButtons) {
      if (seen.has(btn)) continue;

      // Walk up until we find an ancestor holding exactly one Yes and one No.
      let node = btn.parentElement;
      let group = null;
      for (let i = 0; i < 4 && node; i++) {
        const inner = Array.from(node.querySelectorAll("button")).filter((b) =>
          ["yes", "no"].includes(normalize(b.innerText))
        );
        const yesCount = inner.filter((b) => normalize(b.innerText) === "yes").length;
        const noCount = inner.filter((b) => normalize(b.innerText) === "no").length;
        if (inner.length === 2 && yesCount === 1 && noCount === 1) {
          group = { node, buttons: inner };
          break;
        }
        node = node.parentElement;
      }

      if (!group) continue;
      group.buttons.forEach((b) => seen.add(b));
      groups.push(group);
    }

    return groups.map((g, i) => ({
      el: g.node,
      custom: "yesno",
      index: 10000 + i,
      tag: "yesno",
      type: "yesno",
      role: "",
      name: "",
      id: "",
      autocomplete: "",
      placeholder: "",
      label: questionTextFor(g.node),
      options: ["Yes", "No"],
    }));
  }

  function collectFields() {
    return [...collectStandardFields(), ...collectYesNoGroups()];
  }

  // ---------- Heuristic matching ----------
  // Each rule: profile key -> list of regexes tested against EACH source
  // separately (label, name, id, placeholder), so anchors like /^name$/ work.

  const RULES = [
    ["firstName", [/first\s*name/, /given\s*name/, /^fname/, /given-name/]],
    ["lastName", [/last\s*name/, /family\s*name/, /surname/, /^lname/, /family-name/]],
    ["fullName", [/full\s*name/, /^name$/, /your\s*name/, /legal\s*name/, /^_systemfield_name$/]],
    ["email", [/e-?mail/, /^email$/, /^_systemfield_email$/]],
    ["phone", [/phone/, /mobile/, /tel(ephone)?/]],
    ["address1", [/address\s*(line)?\s*1/, /street\s*address/, /^address$/, /address-line1/]],
    ["address2", [/address\s*(line)?\s*2/, /apt|suite|unit/, /address-line2/]],
    ["city", [/city/, /town/, /locality/]],
    ["state", [/state/, /province/, /region/]],
    ["zip", [/zip/, /postal/, /post\s*code/]],
    ["country", [/country/]],
    ["linkedin", [/linked\s*in/]],
    ["github", [/git\s*hub/]],
    ["portfolio", [/portfolio/, /personal\s*(web)?site/, /^website$/, /^url$/]],
    ["school", [/school/, /university/, /college|institution/]],
    ["degree", [/degree/]],
    ["major", [/major/, /field\s*of\s*study/, /discipline/]],
    ["minor", [/minor/]],
    ["projects", [/project(s)?/, /describe.*(project|work)/, /relevant\s*work/]],
    ["gpa", [/gpa|grade\s*point/]],
    ["gradDate", [/graduation|grad\s*date|expected.*(grad|completion)/]],
    ["currentCompany", [/current\s*(company|employer)/, /^company$/, /employer/]],
    ["currentTitle", [/current\s*(title|role|position)/, /job\s*title/]],
    ["salary", [/salary|compensation|pay\s*expectation/]],
    ["referral", [/how\s*did\s*you\s*hear|referral\s*source/]],
    ["workAuth", [/authoriz|legally\s*(able|allowed)\s*to\s*work|work\s*permit|right\s*to\s*work/]],
    ["sponsorship", [/sponsor(ship)?|visa/]],
    ["pronouns", [/pronouns/]],
    ["gender", [/gender/]],
    ["race", [/race|ethnicity/]],
    ["veteran", [/veteran/]],
    ["disability", [/disabilit/]],
    ["coverLetter", [/cover\s*letter|why.*(join|interested|company)|tell\s*us\s*about/]],
  ];

  const AUTOCOMPLETE_MAP = {
    "given-name": "firstName",
    "family-name": "lastName",
    name: "fullName",
    email: "email",
    tel: "phone",
    "tel-national": "phone",
    "address-line1": "address1",
    "address-line2": "address2",
    "address-level2": "city",
    "address-level1": "state",
    "postal-code": "zip",
    country: "country",
    "country-name": "country",
    organization: "currentCompany",
    "organization-title": "currentTitle",
    url: "portfolio",
  };

  function matchField(field) {
    if (AUTOCOMPLETE_MAP[field.autocomplete]) return AUTOCOMPLETE_MAP[field.autocomplete];

    // Ashby UUID names/ids carry no meaning; skip them as match sources.
    const isUuid = (s) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

    const sources = [
      field.label,
      isUuid(field.name) ? "" : field.name,
      isUuid(field.id) ? "" : field.id,
      field.placeholder,
    ].map(normalize);

    for (const [key, regexes] of RULES) {
      if (regexes.some((r) => sources.some((s) => s && r.test(s)))) return key;
    }
    return null;
  }

  // ---------- Filling (React-safe) ----------

  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    // React's synthetic onBlur listens for focusout at the root; blur does not bubble.
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }

  function fillSelect(el, desired) {
    if (!desired) return false;
    const want = normalize(desired);
    const options = Array.from(el.options);
    const best =
      options.find((o) => normalize(o.text) === want) ||
      options.find((o) => normalize(o.text).includes(want)) ||
      options.find((o) => normalize(o.text) && want.includes(normalize(o.text)));
    if (!best) return false;
    setNativeValue(el, best.value);
    return true;
  }

  function fillCheckboxOrRadio(el, desired) {
    if (!desired) return false;
    const want = normalize(desired);
    const yes = ["yes", "true", "y", "1"].includes(want);

    if (el.type === "checkbox") {
      if (yes !== el.checked) el.click();
      return true;
    }

    // Radio: match on the element's OWN label only. Using container text would
    // make both radios in a Yes/No pair match, and the last one would win.
    const own = ownLabelText(el) || normalize(el.value);
    if (!own) return false;
    if (own === want || (yes && own === "yes") || (!yes && own === "no")) {
      el.click();
      return true;
    }
    return false;
  }

  // Ashby Yes/No button pair. Deliberately strict: the value must resolve to
  // yes or no, and only a button whose text is exactly "Yes"/"No" is clicked.
  // This is what prevents a gradDate-style value ("May 2027") from clicking a
  // button, and prevents ever clicking "Submit Application".
  function fillYesNo(groupEl, desired) {
    const want = normalize(desired);
    const yes = ["yes", "true", "y", "1"].includes(want);
    const no = ["no", "false", "n", "0"].includes(want);
    if (!yes && !no) return false;

    const target = Array.from(groupEl.querySelectorAll("button")).find(
      (b) => normalize(b.innerText) === (yes ? "yes" : "no")
    );
    if (!target) return false;
    target.click();
    return true;
  }

  // Ashby typeahead. Typing alone does not commit; the listbox option must be
  // clicked or the field clears on blur.
  async function fillCombobox(el, value) {
    el.focus();
    setNativeValue(el, value);
    el.dispatchEvent(new Event("keydown", { bubbles: true }));

    const want = normalize(value);
    // Poll for the listbox rather than a fixed sleep.
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const opts = Array.from(document.querySelectorAll("[role='option']")).filter(isVisible);
      if (!opts.length) continue;
      const hit =
        opts.find((o) => normalize(o.innerText) === want) ||
        opts.find((o) => normalize(o.innerText).includes(want));
      if (hit) {
        hit.click();
        return true;
      }
    }
    return false;
  }

  async function fillField(field, value) {
    if (value == null || value === "") return false;
    const el = field.el;

    if (field.custom === "yesno") return fillYesNo(el, value);
    if (field.custom === "combobox") return await fillCombobox(el, value);
    if (field.tag === "select") return fillSelect(el, value);
    if (field.type === "checkbox" || field.type === "radio")
      return fillCheckboxOrRadio(el, value);

    el.focus();
    setNativeValue(el, value);
    return true;
  }

  function highlight(el, ok) {
    const prev = el.style.outline;
    el.style.outline = ok ? "2px solid #34d399" : "2px solid #fbbf24";
    setTimeout(() => (el.style.outline = prev), 2500);
  }

  // ---------- Message handling ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "scan") {
      const fields = collectFields();
      window.__appfillFields = fields;
      sendResponse({
        fields: fields.map((f) => ({
          index: f.index,
          tag: f.tag,
          type: f.type,
          name: f.name,
          label: (f.label || "").slice(0, 160),
          options: f.options ? f.options.slice(0, 30) : null,
          matched: matchField(f),
        })),
      });
      return true;
    }

    if (msg.action === "fill") {
      (async () => {
        try {
          const fields = window.__appfillFields || collectFields();
          const profile = msg.profile;
          const aiMap = msg.aiMap || {}; // { index: profileKey|literalValue }
          let filled = 0,
            skipped = 0;

          for (const field of fields) {
            const key = matchField(field);
            let value = key ? profile[key] : null;

            // AI mapping overrides / fills gaps
            if (aiMap[field.index] != null) {
              const mapped = aiMap[field.index];
              value = profile[mapped] !== undefined ? profile[mapped] : mapped;
            }

            // Derived value: fullName from parts
            if (key === "fullName" && !value && profile.firstName) {
              value = `${profile.firstName} ${profile.lastName || ""}`.trim();
            }

            if (value) {
              const ok = await fillField(field, value);
              highlight(field.el, ok);
              ok ? filled++ : skipped++;
            }
          }
          sendResponse({ filled, skipped, total: fields.length });
        } catch (e) {
          sendResponse({ filled: 0, skipped: 0, total: 0, error: String(e) });
        }
      })();
      return true;
    }

    if (msg.action === "scrapeJD") {
      const metaTitle =
        document.querySelector('meta[property="og:title"]')?.content || document.title || "";
      const metaCompany =
        document.querySelector('meta[property="og:site_name"]')?.content || "";

      const candidates = Array.from(
        document.querySelectorAll("main, [role='main'], article, .job-description, #job-description")
      );
      let bodyText = "";
      if (candidates.length) {
        bodyText = candidates
          .map((el) => el.innerText || "")
          .sort((a, b) => b.length - a.length)[0];
      }
      if (!bodyText || bodyText.length < 200) {
        bodyText = document.body.innerText || "";
      }

      sendResponse({
        pageTitle: metaTitle,
        company: metaCompany,
        url: location.href,
        text: bodyText.slice(0, 9000),
      });
      return true;
    }
  });
})();