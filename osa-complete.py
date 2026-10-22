#!/usr/bin/env python
"""Complete the Universität Wien Philosophy OSA and print the final OSA code.

This drives the real page in a real browser, answers every element the tool
renders, and stops on the page that carries the confirmation code.

    python osa-complete.py                 # watch it run
    python osa-complete.py --headless      # no window
    python osa-complete.py --seed 7        # reproduce the same answer set

Why a browser and not HTTP requests: the tool renders each page from a
JavaScript app and posts each answer back over XHR, so a request script would
have to reimplement that protocol and would break the first time the tool
changes. Playwright only touches what a person could touch.

The answers are randomised but never nonsense: single-choice items get one
option, multiple-choice items get one or two, sliders land in the middle, and
free-text fields get a short plausible sentence. The OSA itself says the result
has no effect on admission, so the goal is a complete, plausible record rather
than a particular score.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright
from playwright.sync_api import TimeoutError as PlaywrightTimeout

DEFAULT_URL = (
    "https://self-assessment2.pzle.univie.ac.at/index.php"
    "?t=philo&lc=fHVuaXZpZTIxMzQ5OTM4fHlXdk1Sa2d4fHx8&id=1"
)
OUT_DIR = Path(__file__).resolve().parent / "osa-output"

# Buttons that move forward, best first. "zurück" is never clicked.
ADVANCE_TEXTS = (
    "Los geht's",
    "weiter",
    "Weiter",
    "Fortfahren",
    "Abschließen",
    "Abschliessen",
    "Feedback ansehen",
    "Bestätigung",
    "Fertig",
)
# The confirmation code only exists on the closing pages; the intro also says
# "Ergebnis", and the first version of this script read "durchgef" as a code.
FINAL = re.compile(
    r"osa[\s-]?code|feedbackauswahl|pdf-ansicht|gesamtfeedback|teilnahmebest|"
    r"best(?:ä|ae)tigung|ihr ergebnis|auswertung|vielen dank f(?:ü|ue)r|abgeschlossen",
    re.I,
)
CODE_LABEL = re.compile(
    r"(?:OSA[\s-]?Code|Best(?:ä|ae)tigungscode|Teilnahmecode|Code)"
    r"\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,})",
)
CODE_TOKEN = re.compile(r"\b([A-Za-z0-9]{4,}(?:-[A-Za-z0-9]{4,}){1,3})\b")
CODE_PLAIN = re.compile(r"\b([A-Z0-9]{8,})\b")


def looks_like_code(token: str) -> bool:
    """A code has digits in it; a shouted German word does not."""
    return len(token) >= 8 and sum(ch.isdigit() for ch in token) >= 2

# Injected once. Every branch reads the element's x-type (the tool's own name
# for the widget) and touches the least it can touch to mark it answered.
ANSWER_JS = r"""
() => {
  const out = [];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const many = (arr) => {
    const n = Math.min(arr.length, 1 + Math.floor(Math.random() * 2));
    const copy = [...arr].sort(() => Math.random() - 0.5);
    return copy.slice(0, n);
  };
  const fire = (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.click();
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  for (const el of document.querySelectorAll('.telement')) {
    if (!visible(el)) continue;
    const type = (el.getAttribute('x-type') || '').toLowerCase();
    const radios = [...el.querySelectorAll('input[type=radio]')].filter(visible);
    const boxes = [...el.querySelectorAll('input[type=checkbox]')].filter(visible);
    const selects = [...el.querySelectorAll('select')].filter(visible);
    const texts = [...el.querySelectorAll('input[type=text], input[type=number], textarea')]
      .filter(visible);

    if (type.startsWith('it_') || type === 'repeater') {
      continue;  // chrome, video, login box: not a question
    }

    if (radios.length) {
      const checked = radios.find((r) => r.checked);
      if (!checked) { fire(pick(radios)); out.push([type, 'radio', true]); }
      continue;
    }
    if (boxes.length) {
      const chosen = boxes.filter((b) => b.checked);
      for (const b of (chosen.length ? [] : many(boxes))) { fire(b); }
      out.push([type, 'checkbox', true]);
      continue;
    }
    if (selects.length) {
      for (const sel of selects) {
        const real = [...sel.options].filter((o) => o.value !== '' && !o.disabled);
        if (real.length && (!sel.value || sel.selectedIndex <= 0)) {
          sel.value = pick(real).value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      out.push([type, 'select', true]);
      continue;
    }

    const sortable = el.querySelector('ul.ui-sortable');
    if (sortable && sortable.children.length > 1) {
      // A DOM swap is not an answer: the tool tracks the drag itself, and only
      // a real drag clears the "marked task" dialog. Python does this one.
      out.push([type, 'needs-drag', false]);
      continue;
    }

    const slider = el.querySelector('.ui-slider, [role=slider]');
    if (slider && window.jQuery && window.jQuery(slider).hasClass('ui-slider')) {
      const lo = Number(slider.getAttribute('aria-valuemin') || 0);
      const hi = Number(slider.getAttribute('aria-valuemax') || 10);
      const value = Math.round(lo + (hi - lo) * (0.4 + Math.random() * 0.3));
      try {
        window.jQuery(slider).slider('value', value);
        out.push([type, 'slider', value]);
      } catch (e) { /* leave it */ }
      continue;
    }

    if (texts.length) {
      for (const t of texts) {
        if (t.value) continue;
        const hint = ((t.getAttribute('placeholder') || '') + ' ' +
                      (t.getAttribute('name') || '') + ' ' + type).toLowerCase();
        if (hint.includes('mail')) t.value = 'dummy@example.com';
        else if (t.getAttribute('type') === 'number' || hint.includes('zahl') || hint.includes('stunde'))
          t.value = String(3 + Math.floor(Math.random() * 6));
        else t.value = pick([
          'Ich lese gern und denke über Argumente nach.',
          'Ich interessiere mich für Fragen, die sich nicht schnell beantworten lassen.',
          'Ich arbeite lieber mit Texten als mit Zahlen.',
          'Ich möchte lernen, Argumente sauber zu prüfen.',
        ]);
        t.dispatchEvent(new Event('input', { bubbles: true }));
        t.dispatchEvent(new Event('change', { bubbles: true }));
      }
      out.push([type, 'text', true]);
      continue;
    }

    out.push([type, 'skipped', false]);
  }
  return out;
}
"""


def log(message: str) -> None:
    print(message, flush=True)


def progress(page) -> str:
    """The tool's own progress text, e.g. "35% FORTSCHRITT"."""
    try:
        text = page.inner_text(".progressbars")
    except Exception:
        return ""
    return " ".join(text.split())[:80]


def heading(page) -> str:
    for selector in ("h1", "h2", ".headerbar"):
        try:
            text = page.inner_text(selector).strip()
            if text:
                return " ".join(text.split())[:120]
        except Exception:
            continue
    return ""


def settle(page, slow: float) -> None:
    """Let the XHR that saves the answer finish before reading the screen."""
    try:
        page.wait_for_load_state("networkidle", timeout=20_000)
    except PlaywrightTimeout:
        pass
    overlay = page.locator("#loadingoverlay")
    try:
        if overlay.count() and overlay.first.is_visible():
            overlay.first.wait_for(state="hidden", timeout=20_000)
    except Exception:
        pass
    page.wait_for_timeout(int(slow * 1000))


def drag_sortables(page) -> int:
    """Drag the first item past the second in every sortable on the page.

    The tool's own handler is what records a sortable as answered, and only real
    pointer events reach it; changing the DOM order from script did nothing and
    left the page blocked behind "Sie müssen die markierten Aufgaben bearbeiten".
    """
    moved = 0
    for group in page.locator(".telement[x-type=srt_order]").all():
        if not group.is_visible():
            continue
        items = group.locator("ul.ui-sortable li")
        if items.count() < 3:
            continue
        try:
            items.nth(0).drag_to(items.nth(2), timeout=10_000)
            moved += 1
        except Exception:
            continue
    return moved


def safe_click(page, target, timeout: int = 8000) -> bool:
    """Click, and if an overlay is in the way, clear it and try once more."""
    try:
        target.click(timeout=timeout)
        return True
    except PlaywrightTimeout:
        said = clear_dialog(page)
        if said:
            log(f"      dialog: {said}")
        try:
            target.click(timeout=timeout, force=True)
            return True
        except Exception:
            return False
    except Exception:
        return False


def click_advance(page) -> str:
    """Click the visible forward control.

    The page ships hidden template copies of its navigation (a login box, a
    dialog footer) that come first in the DOM, so "the first button called
    weiter" is invisible and does nothing. Every candidate is checked for
    visibility and enabled state before it is clicked.
    """
    selectors = ("button[x-nextbtn]", "button.next", "button.loginbtn")
    for selector in selectors:
        locator = page.locator(selector)
        for index in range(locator.count()):
            target = locator.nth(index)
            if target.is_visible() and target.is_enabled():
                if safe_click(page, target):
                    return selector
    for label in ADVANCE_TEXTS:
        locator = page.get_by_role("button", name=re.compile(rf"^{re.escape(label)}$", re.I))
        for index in range(locator.count()):
            target = locator.nth(index)
            if target.is_visible() and target.is_enabled():
                if safe_click(page, target):
                    return label
    for selector in ("[x-exitmodule]",
                     "[x-type=it_moduleoverview] a", "[x-type=it_moduleoverview] li",
                     ".moduleoverview a", ".moduleoverview li", ".module a", ".pg_btn"):
        locator = page.locator(selector)
        for index in range(locator.count()):
            target = locator.nth(index)
            if target.is_visible() and target.is_enabled():
                if safe_click(page, target):
                    return selector
    return ""


def clear_dialog(page) -> str:
    """Close a blocking dialog and report what it said.

    The tool uses two: its own .dialogwnd and jQuery UI's .ui-dialog, and the
    second one puts .ui-widget-overlay over the page so every later click times
    out. Both are dismissed by the first button they offer.
    """
    for selector in (".ui-dialog:visible", ".dialogwnd:visible"):
        dialog = page.locator(selector)
        for index in range(dialog.count()):
            target = dialog.nth(index)
            if not target.is_visible():
                continue
            message = " ".join(target.inner_text().split())[:200]
            for label in ("Okay", "OK", "Ok", "Schließen", "Weiter", "Ja", "Close"):
                button = target.get_by_role("button", name=re.compile(rf"^{label}$", re.I))
                if button.count():
                    try:
                        button.first.click(timeout=5000)
                        return message
                    except Exception:
                        continue
            return message
    return ""


def collect_code(page) -> str:
    """The confirmation code, only from a page that is actually the end."""
    text = " ".join(page.inner_text("body").split())
    if not FINAL.search(text):
        return ""
    for pattern in (CODE_LABEL, CODE_TOKEN, CODE_PLAIN):
        for match in pattern.finditer(text):
            token = match.group(1).strip("-")
            if looks_like_code(token):
                return token
    return ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--headless", action="store_true", help="no visible window")
    parser.add_argument("--seed", type=int, default=None, help="reproducible answers")
    parser.add_argument("--slow", type=float, default=0.4,
                        help="seconds to pause after each page (default 0.4)")
    parser.add_argument("--max-pages", type=int, default=120)
    parser.add_argument("--out", default=str(OUT_DIR))
    args = parser.parse_args(argv)

    if args.seed is not None:
        random.seed(args.seed)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = None
        for kwargs in ({"channel": "msedge"}, {"channel": "chrome"}, {}):
            try:
                browser = playwright.chromium.launch(headless=args.headless, **kwargs)
                break
            except Exception:
                continue
        if browser is None:
            log("No browser could be started. Install one with: playwright install chromium")
            return 2

        page = browser.new_page()
        page.set_default_timeout(30_000)
        page.goto(args.url, wait_until="networkidle", timeout=90_000)
        settle(page, args.slow)

        transcript: list[dict] = []
        seen_pages: dict[str, int] = {}
        code = ""

        for step in range(1, args.max_pages + 1):
            said = clear_dialog(page)
            if said:
                log(f"      dialog: {said}")
            title = heading(page)
            where = progress(page)
            answers = page.evaluate(ANSWER_JS)
            dragged = drag_sortables(page)
            answered = [a for a in answers if a[2]]
            transcript.append({"step": step, "title": title, "progress": where,
                               "answers": answers})
            log(f"[{step:02d}] {where or '-':<22} and {dragged} sorted; "
                f"answered {len(answered)}/{len(answers)}")

            if step % 5 == 1:
                shot = out_dir / "screens"
                shot.mkdir(exist_ok=True)
                page.screenshot(path=str(shot / f"step-{step:02d}.png"), full_page=True)

            code = collect_code(page)
            if code:
                log(f"Code found on this page: {code}")
                break

            marker = f"{where}|{title}|{len(answered)}"
            seen_pages[marker] = seen_pages.get(marker, 0) + 1
            if seen_pages[marker] > 2:
                # Same page three times: an unanswered field is blocking it.
                log("This page keeps coming back; re-answering and retrying once.")
                page.evaluate(ANSWER_JS)
                settle(page, args.slow)

            used = click_advance(page)
            if not used:
                log("No forward button on this page; stopping here.")
                break
            settle(page, args.slow)
            said = clear_dialog(page)
            if said:
                log(f"      dialog: {said}")
                settle(page, args.slow)

            body = page.inner_text("body")
            if re.search(r"Vielen Dank|abgeschlossen|beendet", body, re.I):
                code = collect_code(page)
                if code:
                    break

        # The confirmation page sometimes only exposes the code on a button press.
        if not code:
            for label in ("Bestätigung", "Zertifikat", "PDF speichern", "Ergebnis anzeigen"):
                button = page.get_by_role("button", name=re.compile(label, re.I))
                if button.count() and button.first.is_visible():
                    button.first.click()
                    settle(page, args.slow)
                    code = collect_code(page)
                    if code:
                        break

        final_text = " ".join(page.inner_text("body").split())
        (out_dir / "final-page.txt").write_text(final_text, encoding="utf-8")
        (out_dir / "transcript.json").write_text(
            json.dumps({"url": args.url, "code": code, "pages": transcript},
                       ensure_ascii=False, indent=2), encoding="utf-8")

        for link in page.locator("a[href$='.pdf'], a[href*='pdf']").all()[:3]:
            try:
                href = link.get_attribute("href") or ""
                if href:
                    response = page.request.get(href if href.startswith("http")
                                                else args.url.rsplit("/", 1)[0] + "/" + href)
                    if response.ok:
                        path = out_dir / ("osa-feedback.pdf")
                        path.write_bytes(response.body())
                        log(f"Saved the feedback PDF to {path}")
                        break
            except Exception:
                continue

        log("")
        if code:
            (out_dir / "OSA-CODE.txt").write_text(code + "\n", encoding="utf-8")
            log(f"OSA CODE: {code}")
            log(f"Saved to {out_dir / 'OSA-CODE.txt'}")
        else:
            log("No code was found. The final page was saved to "
                f"{out_dir / 'final-page.txt'} — read it, or run with the window "
                "visible to see where it stopped.")
        log(f"Transcript: {out_dir / 'transcript.json'}")
        browser.close()
        return 0 if code else 1


if __name__ == "__main__":
    sys.exit(main())
