"""Real Chromium, intercepted fixtures only: never contacts a school or sends a live message."""
import asyncio
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.cache import Cache
from email_finder.fetch import Fetcher
from email_finder.forms import FormSender
import email_finder.forms as forms_module

TASK = {'url': 'https://school.test/contact', 'subject': 'A business follow-up', 'body': 'Here is the business proposal.',
        'sender': {'name': 'Alex Baker', 'email': 'alex@business.org', 'phone': '+12025550123'}}

@pytest.mark.parametrize('mode,status,expected_sends', [
    ('send', 'SENT', 1), ('dry', 'PREPARED', 0), ('cancel', 'MANUAL', 0),
    ('student', 'MANUAL', 0), ('captcha', 'MANUAL', 0), ('uncertain', 'MANUAL', 1),
])
def test_submission_flow(tmp_path, monkeypatch, mode, status, expected_sends):
    async def run():
        async def allow(url): return True
        monkeypatch.setattr(forms_module, 'public_url', allow)
        fetcher = Fetcher(Cache(tmp_path / 'cache.db'))
        sends, arms = [], []
        extra = '<label>Student age<input required type="number" name="age"></label>' if mode == 'student' else ''
        if mode == 'captcha':
            extra = '<div class="g-recaptcha">Verify you are a human</div>'
        html = '''<html><body><form id="contact"><label>Your name<input name="name" required></label>
          <label>Your email<input type="email" name="email" required></label>
          <label>Message<textarea name="message" required></textarea></label>''' + extra + '''
          <button type="submit">Send message</button></form><script>
          document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();
          const data=Object.fromEntries(new FormData(e.target));
          const response=await fetch('/submit',{method:'POST',body:JSON.stringify(data)});
          document.body.innerHTML=await response.text();};</script></body></html>'''
        async def guard(page):
            async def route(r):
                if r.request.method == 'POST':
                    sends.append(r.request.post_data_json)
                    await r.fulfill(status=200, content_type='text/html', body='Processing' if mode == 'uncertain' else 'Your message has been sent')
                else:
                    await r.fulfill(status=200, content_type='text/html', body=html)
            await page.route('**/*', route)
        fetcher.guard_page = guard
        async def arm():
            arms.append(1)
            return mode != 'cancel'
        try:
            result = await FormSender(fetcher).send(TASK, arm, dry_run=mode == 'dry')
            assert result.status == status, result.notes
            assert len(sends) == expected_sends
            if sends:
                assert sends[0]['message'] == TASK['subject'] + '\n\n' + TASK['body']
                assert sends[0]['email'] == TASK['sender']['email']
            if mode in ('student', 'captcha', 'dry'):
                assert not arms
        finally:
            await fetcher.close()
    asyncio.run(run())


def test_google_hosted_multistep_form(tmp_path, monkeypatch):
    async def run():
        async def allow(url): return True
        monkeypatch.setattr(forms_module, 'public_url', allow)
        fetcher = Fetcher(Cache(tmp_path / 'cache.db'))
        sends = []
        async def guard(page):
            async def route(r):
                url = r.request.url
                if r.request.method == 'POST':
                    sends.append(r.request.post_data_json)
                    await r.fulfill(status=200, content_type='text/html', body='Your response has been recorded')
                elif 'school.test' in url:
                    await r.fulfill(content_type='text/html', body='<a href="https://forms.gle/test">Contact our school</a>')
                elif 'forms.gle' in url:
                    # Playwright only routes the first URL in an HTTP redirect
                    # chain. A client navigation keeps this fixture intercepted.
                    # https://playwright.dev/python/docs/api/class-page#page-route
                    await r.fulfill(content_type='text/html', body='''<script>
                      location.replace('https://docs.google.com/forms/d/test/viewform');
                      </script>''')
                else:
                    await r.fulfill(content_type='text/html', body='''<html><body><form>
                      <div role="listitem"><h3 id="q1">Email</h3><input type="email" aria-labelledby="q1" required></div>
                      <div role="button" tabindex="0" onclick="next()">Next</div></form><script>
                      function next(){document.querySelector('form').innerHTML='<div role="listitem"><h3 id="q2">Your message</h3><textarea aria-labelledby="q2" required></textarea></div><div role="button" tabindex="0" onclick="send()">Submit</div>';}
                      async function send(){const message=document.querySelector('textarea').value;
                      const r=await fetch('/submit',{method:'POST',body:JSON.stringify({message})});document.body.innerHTML=await r.text();}
                      </script></body></html>''')
            await page.route('**/*', route)
        fetcher.guard_page = guard
        async def arm(): return True
        try:
            result = await FormSender(fetcher).send(TASK, arm)
            assert result.status == 'SENT', result.notes
            assert sends == [{'message': TASK['subject'] + '\n\n' + TASK['body']}]
        finally:
            await fetcher.close()
    asyncio.run(run())


# Shapes seen on real school sites in a dry run of 45 contact pages (2026-10-07).
BASE_FIELDS = '''<label>Your name<input name="name" required></label>
  <label>Your email<input type="email" name="email" required></label>'''
SUBMIT_JS = '''<script>document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();
  const r=await fetch('/submit',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});
  const t=await r.text();
  if(t.startsWith('REDIRECT:')) location.href=t.slice(9);
  else if(t.startsWith('SLOW:')) setTimeout(()=>{document.body.innerHTML=t.slice(5)},8000);
  else document.body.innerHTML=t;};</script>'''
SHAPES = {
    # A message prompt that mentions trial classes is still the message box.
    'trial-prompt': (BASE_FIELDS + '<label>Dropping in? Interested in a trial class? Let us know!<textarea name="message"></textarea></label>'
                     '<button type="submit">Send</button>', 'Your message has been sent', 'SENT'),
    'split-name-contact-number': ('<fieldset><legend>Name</legend><label>First<input name="first" required></label>'
                                  '<label>Last<input name="last" required></label></fieldset>'
                                  '<label>Email<input type="email" name="email" required></label>'
                                  '<label>Contact Number *<input name="number" required></label>'
                                  '<label>Message<textarea name="message" required></textarea></label>'
                                  '<button type="submit">Send</button>', 'Your message has been sent', 'SENT'),
    'digits-only-phone': (BASE_FIELDS + '<label>Phone number<input type="tel" name="phone" pattern="[0-9\\-]*" required></label>'
                          '<label>Comment<textarea name="message"></textarea></label><button type="submit">Send</button>',
                          'Your message has been sent', 'SENT'),
    'floated-form': ('<div style="height:0">' + BASE_FIELDS.replace('<label>', '<label style="float:left">') +
                     '<label style="float:left">Message<textarea name="message"></textarea></label>'
                     '<button style="float:left" type="submit">Send message</button></div>', 'Your message has been sent', 'SENT'),
    'hidden-duplicate-submit': (BASE_FIELDS + '<label>Ask us anything<textarea name="message"></textarea></label>'
                                '<button type="submit" style="display:none">Get In Touch</button><button type="submit">Get In Touch</button>',
                                'Your message has been sent', 'SENT'),
    'late-captcha': (BASE_FIELDS + '<label>Message<textarea name="message"></textarea></label>'
                     '<span class="wpcf7-form-control wpcf7-recaptcha g-recaptcha" data-sitekey="x"></span>'
                     '<button type="submit">Send</button>', 'Your message has been sent', 'MANUAL'),
    # Confirmations: page copy already promising a reply does not block a new one.
    'wpforms-copy': ('<p>Send us a message and we\'ll get back to you.</p>' + BASE_FIELDS +
                     '<label>Message<textarea name="message"></textarea></label><button type="submit">Send</button>',
                     "<p>Send us a message and we'll get back to you.</p><p>Thanks for contacting us! We will be in touch with you shortly.</p>", 'SENT'),
    'squarespace-thank-you': (BASE_FIELDS + '<label>Message<textarea name="message"></textarea></label><button type="submit">Submit</button>',
                              '<p>Thank you!</p>', 'SENT'),
    'thank-you-redirect': (BASE_FIELDS + '<label>Message<textarea name="message"></textarea></label><button type="submit">Send</button>',
                           'REDIRECT:https://school.test/thank-you/', 'SENT'),
    'slow-mailer': (BASE_FIELDS + '<label>Message<textarea name="message"></textarea></label><button type="submit">Send</button>',
                    'SLOW:Your message was sent successfully.', 'SENT'),
    'error-after-submit': (BASE_FIELDS + '<label>Message<textarea name="message"></textarea></label><button type="submit">Send</button>',
                           '<p>There was an error trying to send your message. Please try again later.</p>' + BASE_FIELDS, 'MANUAL'),
}


@pytest.mark.parametrize('shape', list(SHAPES))
def test_real_world_form_shapes(tmp_path, monkeypatch, shape):
    fields, reply, status = SHAPES[shape]

    async def run():
        async def allow(url): return True
        monkeypatch.setattr(forms_module, 'public_url', allow)
        fetcher = Fetcher(Cache(tmp_path / 'cache.db'))
        sends, arms = [], []
        page_html = f'<html><body><form id="contact">{fields}</form>{SUBMIT_JS}</body></html>'

        async def guard(page):
            async def route(r):
                if r.request.method == 'POST':
                    sends.append(r.request.post_data_json)
                    await r.fulfill(status=200, content_type='text/html', body=reply)
                elif r.request.url.endswith('/thank-you/'):
                    await r.fulfill(status=200, content_type='text/html', body='<p>Great, we got it.</p>')
                else:
                    await r.fulfill(status=200, content_type='text/html', body=page_html)
            await page.route('**/*', route)
        fetcher.guard_page = guard

        async def arm():
            arms.append(1)
            return True
        try:
            result = await FormSender(fetcher).send(TASK, arm)
            assert result.status == status, result.notes
            if shape == 'late-captcha':
                assert not arms and not sends
                return
            assert len(sends) == 1  # exactly one submission, success or not
            sent = sends[0]
            assert sent['message'] == TASK['subject'] + '\n\n' + TASK['body']
            if shape == 'split-name-contact-number':
                assert (sent['first'], sent['last'], sent['number']) == ('Alex', 'Baker', TASK['sender']['phone'])
            if shape == 'digits-only-phone':
                assert sent['phone'] == '12025550123'
        finally:
            await fetcher.close()
    asyncio.run(run())
