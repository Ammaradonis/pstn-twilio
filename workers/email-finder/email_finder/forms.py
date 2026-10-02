"""Deliver an already-scheduled business follow-up through a public contact form.

No messages are sent during discovery. Submission needs the API's one-use arm
step. Unknown outcomes and unsupported required questions go to manual review.
"""
from __future__ import annotations
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .fetch import CHALLENGE, Fetcher
from .urls import form_host, public_url

SUCCESS = re.compile(r"your (?:response|message|submission|enquiry|inquiry) (?:has been|was) (?:recorded|sent|submitted|received)|"
                     r"thank you for (?:contacting|your (?:message|enquiry|inquiry|submission))|"
                     r"message sent successfully|we have received your", re.I)
CAPTCHA = re.compile(r"captcha|verify.*human|not a robot|security challenge", re.I)


@dataclass
class FormResult:
    status: str
    notes: str = ""


def answer_field(label: str, kind: str, sender: dict, message: str, subject: str) -> str | None:
    """Only truthful sender/contact information and explicit business-inquiry answers."""
    label = re.sub(r"[_\-]+", " ", label).lower()
    if CAPTCHA.search(label) or kind in {"password", "file", "date", "checkbox", "radio"}:
        return None
    if re.search(r"\b(student|child|age|birth|belt|experience|medical|gender|class|trial|course)\b", label):
        return None
    if re.search(r"message|comments?|how can we help|details of (?:your )?(?:enquiry|inquiry)|your (?:enquiry|inquiry)", label) or kind == "textarea":
        return message
    if kind == "email" or re.search(r"e ?mail", label):
        return sender.get("email") or None
    if kind == "tel" or re.search(r"phone|telephone|mobile", label):
        return sender.get("phone") or None
    if re.search(r"first name|given name|firstname", label):
        return (sender.get("name") or "").split(" ")[0] or None
    if re.search(r"last name|surname|lastname", label):
        parts = (sender.get("name") or "").split(" ", 1)
        return parts[1] if len(parts) > 1 else None
    if re.search(r"company|organisation|organization|business name", label):
        return sender.get("company") or None
    if re.search(r"website|web site", label):
        return sender.get("website") or None
    if re.search(r"\bname\b|fullname", label):
        return sender.get("name") or None
    if re.search(r"subject", label):
        return subject
    if re.search(r"reason|purpose|type of (?:enquiry|inquiry)|interested in", label):
        return "Business enquiry — following up on a call to the school."
    if re.search(r"how did you (?:hear|find)|where did you (?:hear|find)", label):
        return "Your public business listing."
    return None


# Assign ephemeral selectors; do not rely on unstable Google Forms class names.
FIELDS_JS = r"""root => {
  const nodes = [...root.querySelectorAll('input,textarea,select,[role=textbox],[role=radiogroup],[role=checkbox],[role=listbox]')];
  return nodes.filter(el => !['hidden','submit','button','reset'].includes(el.type)).map((el, i) => {
    el.setAttribute('data-email-finder-field', String(i));
    const group = el.closest('[role=listitem],fieldset,.form-group,.field');
    const described = (el.getAttribute('aria-labelledby') || '').split(' ').map(id => document.getElementById(id)?.textContent || '').join(' ');
    const label = [...(el.labels || [])].map(l => l.textContent).join(' ') || el.getAttribute('aria-label') || described ||
      group?.querySelector('legend,[role=heading],label')?.textContent || el.placeholder || el.name || '';
    const tag = el.tagName.toLowerCase();
    return {id: i, label: label.trim().slice(0,300), kind: tag === 'textarea' ? tag : tag === 'select' ? tag : el.type || el.getAttribute('role') || 'text',
      required: Boolean(el.required || el.getAttribute('aria-required') === 'true' || group?.getAttribute('aria-required') === 'true'),
      options: tag === 'select' ? [...el.options].map(o => ({value:o.value, label:o.textContent.trim()})) : []};
  });
}"""


class FormSender:
    def __init__(self, fetcher: Fetcher, answers_path: Path | None = None):
        self.fetcher = fetcher
        self.answers = {}
        if answers_path and answers_path.exists():
            self.answers = json.loads(answers_path.read_text(encoding="utf-8-sig"))

    async def send(self, task: dict, arm, dry_run: bool = False) -> FormResult:
        url = task["url"]
        if not self.fetcher.use_browser or not await public_url(url):
            return FormResult("MANUAL", "Contact form URL or browser is unavailable.")
        sender = {**task.get("sender", {})}
        for key in ("name", "email", "phone", "company", "website"):
            sender[key] = os.environ.get("EMAIL_FINDER_SENDER_" + key.upper()) or sender.get(key, "")
        message = task["subject"].strip() + "\n\n" + task["body"].strip()
        context = None
        armed = False
        async with self.fetcher._browser_lock:
            try:
                browser = await self.fetcher._ensure_browser()
                context = await browser.new_context(locale="en-GB", service_workers="block")
                page = await context.new_page()
                await self.fetcher.guard_page(page)
                await page.goto(url, wait_until="domcontentloaded", timeout=25_000)
                await page.wait_for_timeout(1200)
                filled_message = False
                for step in range(6):
                    html = await page.content()
                    if CHALLENGE.search(html) or "/accounts/" in page.url:
                        return FormResult("MANUAL", "Human verification or sign-in required.")
                    scope = page
                    if not await page.locator("textarea,[role=textbox]").count():
                        # Follow only a known embedded form or explicit hosted-form link.
                        embedded = next((f for f in page.frames[1:] if form_host(f.url)), None)
                        if embedded:
                            scope = embedded
                        else:
                            links = await page.locator("a[href]").evaluate_all("els => els.map(e => e.href)")
                            target = next((u for u in links if form_host(u)), None)
                            if target and target != page.url and await public_url(target):
                                await page.goto(target, wait_until="domcontentloaded", timeout=25_000)
                                await page.wait_for_timeout(1000)
                                scope = page
                    # Do not send through login, newsletter, checkout or booking forms.
                    forms = scope.locator("form")
                    candidates = []
                    for form in await forms.all():
                        if await form.is_visible() and not await form.locator("input[type=password],input[type=file]").count():
                            count = await form.locator("textarea,[role=textbox]").count()
                            candidates.append((count, form))
                    if not candidates:
                        return FormResult("MANUAL", "No supported contact form found.")
                    candidates.sort(key=lambda f: -f[0])
                    form = candidates[0][1]
                    for captcha in await form.locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile').all():
                        if await captcha.is_visible():
                            return FormResult("MANUAL", "The form requires human verification.")
                    descriptors = await form.evaluate(FIELDS_JS)
                    host = (urlsplit(scope.url).hostname or "").lower()
                    overrides = self.answers.get(host, {})
                    for field in descriptors:
                        control = form.locator(f'[data-email-finder-field="{field["id"]}"]')
                        if not await control.is_visible() or not await control.is_enabled():
                            continue
                        label, kind = field["label"], field["kind"]
                        required = field["required"]
                        value = overrides.get(label) or answer_field(label, kind, sender, message, task["subject"])
                        if kind == "select":
                            options = field["options"]
                            option = next((o for o in options if value and o["label"].casefold() == value.casefold()), None)
                            if option is None and not re.search(r"student|age|class|belt|trial|medical", label, re.I):
                                option = next((o for o in options if re.fullmatch(r"business (?:enquiry|inquiry)|general (?:enquiry|inquiry)|other", o["label"], re.I)), None)
                            if option:
                                await control.select_option(option["value"])
                            elif required:
                                return FormResult("MANUAL", f"Required selection needs review: {label[:150]}")
                            continue
                        if kind in ("radiogroup", "listbox"):
                            # A truthful "Business enquiry" or "Other" is suitable for purpose fields.
                            purpose = re.search(r"reason|purpose|enquiry|inquiry|contact.*about|interested in", label, re.I)
                            if purpose or label in overrides:
                                option_name = re.compile(r"^(business (?:enquiry|inquiry)|general (?:enquiry|inquiry)|other)$", re.I)
                                choice = control.get_by_role("radio" if kind == "radiogroup" else "option", name=overrides.get(label) or option_name)
                                if kind == "listbox":
                                    await control.click(timeout=4000)
                                    choice = scope.get_by_role("option", name=overrides.get(label) or option_name)
                                if await choice.count():
                                    await choice.first.click(timeout=4000)
                                    continue
                            if required:
                                return FormResult("MANUAL", f"Required choice needs review: {label[:150]}")
                            continue
                        if kind in ("radio", "checkbox"):
                            if required:
                                return FormResult("MANUAL", f"Required choice/consent needs review: {label[:150]}")
                            continue
                        if value is None:
                            if required:
                                return FormResult("MANUAL", f"Required question needs an honest answer: {label[:150]}")
                            continue
                        maxlength = await control.get_attribute("maxlength")
                        if maxlength and maxlength.isdigit() and len(value) > int(maxlength):
                            return FormResult("MANUAL", "The form cannot fit the complete follow-up message.")
                        await control.fill(value, timeout=4000)
                        filled_message |= value == message
                    invalid = await form.evaluate("el => [...el.querySelectorAll('input,textarea,select')].some(e => e.offsetParent !== null && e.willValidate && !e.checkValidity())")
                    if invalid:
                        return FormResult("MANUAL", "The form has unresolved validation errors.")
                    submit = form.get_by_role("button", name=re.compile(r"^(submit|send|send message|send enquiry|send inquiry|submit form|submit message)$", re.I))
                    if not await submit.count():
                        submit = form.locator("button[type=submit],input[type=submit]")
                    # Google Forms uses role=button for Next and Submit.
                    next_button = form.get_by_role("button", name=re.compile(r"^next$", re.I))
                    if await next_button.count() and not await submit.count():
                        await next_button.first.click(timeout=4000)
                        await page.wait_for_timeout(700)
                        continue
                    if not filled_message or await submit.count() != 1:
                        return FormResult("MANUAL", "No unambiguous message field and Submit button found.")
                    if dry_run:
                        return FormResult("PREPARED", "Form filled with the complete subject and body; submission disabled.")
                    before = await scope.locator("body").inner_text()
                    if not await arm():
                        return FormResult("MANUAL", "Submission lease expired or follow-up was cancelled.")
                    armed = True
                    # This is the only submit click. Never repeat after a timeout or lost response.
                    await submit.click(timeout=8000)
                    for _ in range(8):
                        await page.wait_for_timeout(750)
                        after = await scope.locator("body").inner_text()
                        confirmations = SUCCESS.findall(after)
                        if confirmations and after != before and not SUCCESS.search(before):
                            return FormResult("SENT")
                    return FormResult("MANUAL", "Submitted once, but no clear success confirmation. Check delivery before resending.")
                return FormResult("MANUAL", "Form has too many steps; review required.")
            except Exception as err:
                return FormResult("MANUAL", "Submission outcome uncertain; check delivery before resending." if armed
                                  else f"Form could not be prepared ({type(err).__name__}); review required.")
            finally:
                if context:
                    await context.close()
